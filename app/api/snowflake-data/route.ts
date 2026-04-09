/**
 * POST /api/snowflake-data
 * Fetches account managers, tasks, usage, NPS, and Intercom tickets from Snowflake
 * for the provided list of organization UUIDs / account codes.
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sfQuery, sfInList } from '@/lib/snowflake'

const g = global as any
if (!g.__sfCache) g.__sfCache = {}
const CACHE_TTL_MS = 10 * 60 * 1000

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orgUuids } = await req.json()
  if (!Array.isArray(orgUuids) || !orgUuids.length) {
    return NextResponse.json({ error: 'orgUuids required' }, { status: 400 })
  }

  const cacheKey = [...orgUuids].sort().join(',')
  const cached = g.__sfCache[cacheKey]
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(cached.data)
  }

  const list = sfInList(orgUuids)
  if (!list) return NextResponse.json({ accountManagers: {}, tasks: [], usage: [], nps: [], tickets: [] })

  try {
    const [accountRows, taskRows, usageRows, npsRows, ticketRows] = await Promise.all([

      sfQuery(`
        SELECT ORGANIZATION_UUID__C, ACCOUNT_OWNER_TEXT__C
        FROM CLEAN.SALESFORCE.ACCOUNT
        WHERE ORGANIZATION_UUID__C IN (${list})
          AND ORGANIZATION_UUID__C IS NOT NULL
          AND ACCOUNT_OWNER_TEXT__C IS NOT NULL
      `).catch(e => { console.error('[snowflake-data] accounts query failed:', e.message); return [] }),

      sfQuery(`
        SELECT
          a.ORGANIZATION_UUID__C,
          t.SUBJECT,
          t.DESCRIPTION,
          t.ACTIVITYDATE,
          t.TASKSUBTYPE,
          t.STATUS
        FROM CLEAN.SALESFORCE.TASK t
        JOIN CLEAN.SALESFORCE.ACCOUNT a ON t.ACCOUNTID = a.ID
        WHERE a.ORGANIZATION_UUID__C IN (${list})
          AND t.ACTIVITYDATE >= DATEADD(year, -1, CURRENT_DATE)
        ORDER BY t.ACTIVITYDATE DESC
      `).catch(e => { console.error('[snowflake-data] tasks query failed:', e.message); return [] }),

      sfQuery(`
        SELECT ACCOUNT_CODE, USECASE, LEVEL_1, KEY_ACTION
        FROM DERIVED.PRODUCT.FCT_FEATURE_USAGE_BY_USER__WRK
        WHERE ACCOUNT_CODE IN (${list})
          AND USAGE_DATE >= DATEADD(day, -90, CURRENT_DATE)
      `).catch(e => { console.error('[snowflake-data] usage query failed:', e.message); return [] }),

      sfQuery(`
        SELECT *
        FROM CLEAN.WOOTRIC_NPS.RESPONSES
        WHERE END_USER__PROPERTIES__ACCOUNT_CODE IN (${list})
      `).catch(e => { console.error('[snowflake-data] nps query failed:', e.message); return [] }),

      sfQuery(`
        SELECT DISTINCT
          t.TICKET_ID,
          t.TICKET_STATE,
          t.CREATED_AT,
          t.UPDATED_AT,
          t.TICKET_ATTRIBUTES:"_default_title_"::STRING   AS TITLE,
          t.TICKET_ATTRIBUTES:"Ticket Issue Type"::STRING AS ISSUE_TYPE,
          t.TICKET_ATTRIBUTES:"Ticket Priority"::STRING   AS PRIORITY,
          co.COMPANY_ID                                   AS ACCOUNT_CODE
        FROM CLEAN.INTERCOM.TICKETS t,
          LATERAL FLATTEN(input => t.CONTACTS:contacts) tc
        JOIN CLEAN.INTERCOM.CONTACTS ct ON ct.ID = tc.value:id::STRING,
          LATERAL FLATTEN(input => ct.COMPANIES:data) cc
        JOIN CLEAN.INTERCOM.COMPANIES co ON co.ID = cc.value:id::STRING
        WHERE co.COMPANY_ID IN (${list})
        ORDER BY t.CREATED_AT DESC
      `).catch(e => { console.error('[snowflake-data] tickets query failed:', e.message); return [] }),

    ])

    const accountManagers: Record<string, string> = {}
    for (const r of accountRows) {
      if (r.ORGANIZATION_UUID__C && r.ACCOUNT_OWNER_TEXT__C) {
        accountManagers[r.ORGANIZATION_UUID__C] = r.ACCOUNT_OWNER_TEXT__C
      }
    }

    const payload = { accountManagers, tasks: taskRows, usage: usageRows, nps: npsRows, tickets: ticketRows }
    g.__sfCache[cacheKey] = { data: payload, at: Date.now() }
    return NextResponse.json(payload)
  } catch (err) {
    console.error('[/api/snowflake-data] failed:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
