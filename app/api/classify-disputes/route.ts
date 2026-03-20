/**
 * AR360 — Nightly Dispute Classification
 * POST /api/classify-disputes
 *
 * Called by a cron job (Vercel Cron or GitHub Action) once per night.
 * For each customer with an open balance:
 *   1. Fetches recent Salesforce tasks (primary signal)
 *   2. Fetches Gmail AR inbox threads matching their domain (fallback / supplement)
 *   3. Calls Claude to classify the dispute type
 *   4. Writes results to dispute-classifications.json (or your DB of choice)
 *
 * Protect this route with a shared secret (CRON_SECRET env var).
 */

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs/promises'
import * as path from 'path'
import Papa from 'papaparse'
import { google } from 'googleapis'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisputeCategory =
  | 'cancellation_dispute'
  | 'payment_method_failure'
  | 'seat_pricing_dispute'
  | 'enterprise_ap_delay'
  | 'auto_renewal_confusion'
  | 'international_payment_barrier'
  | 'product_dissatisfaction'
  | 'billing_error'
  | 'no_dispute_detected'
  | 'insufficient_data'

export type CollectionProbability = 'high' | 'medium' | 'low'

export type RecommendedAction =
  | 'send_payment_link'
  | 'loop_in_csm'
  | 'send_compliance_docs'
  | 'schedule_followup'
  | 'escalate_legal'
  | 'offer_seat_reduction'
  | 'clarify_auto_renewal'
  | 'correct_invoice'
  | 'standard_collections'
  | 'no_action'

export interface DisputeClassification {
  org_uuid: string
  company_name: string
  dispute_category: DisputeCategory
  confidence: 'high' | 'medium' | 'low'
  collection_probability: CollectionProbability
  recommended_action: RecommendedAction
  /** One-sentence summary of the situation for the AR rep */
  summary: string
  /** Risk score modifier — added to existing AR360 risk score (+/- 0-40) */
  risk_modifier: number
  signal_source: 'salesforce' | 'gmail' | 'salesforce+gmail' | 'none'
  classified_at: string
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // Auth check — require CRON_SECRET header
  const secret = req.headers.get('x-cron-secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Load current AR360 customer data (Upflow CSV already parsed into state)
  // Adjust this path / import to match your actual data layer
  const customers = await loadOpenBalanceCustomers()

  const results: DisputeClassification[] = []
  const errors: { org_uuid: string; error: string }[] = []

  for (const customer of customers) {
    try {
      const classification = await classifyCustomer(anthropic, customer)
      results.push(classification)
      // Small delay to respect Gmail API rate limits (250 req/100s)
      await sleep(400)
    } catch (err) {
      errors.push({ org_uuid: customer.org_uuid, error: String(err) })
    }
  }

  // Write results to a JSON file — swap for DB write if you have one
  const outputPath = path.join(process.cwd(), 'data', 'dispute-classifications.json')
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    count: results.length,
    results
  }, null, 2))

  return NextResponse.json({
    ok: true,
    classified: results.length,
    errors: errors.length,
    error_details: errors,
  })
}

// ---------------------------------------------------------------------------
// Core classification logic
// ---------------------------------------------------------------------------

async function classifyCustomer(
  anthropic: Anthropic,
  customer: CustomerRecord
): Promise<DisputeClassification> {
  // 1. Fetch Salesforce tasks (already available via your SF CSV / API)
  const sfTasks = await fetchSalesforceTasks(customer.org_uuid)

  // 2. Fetch Gmail threads — only if SF tasks are >14 days old or missing
  const sfIsRecent = sfTasks.length > 0 &&
    daysSince(sfTasks[0].date) <= 14

  const gmailSnippets = sfIsRecent
    ? []
    : await fetchGmailSnippets(customer.domain)

  const signalSource =
    sfTasks.length > 0 && gmailSnippets.length > 0 ? 'salesforce+gmail'
    : sfTasks.length > 0 ? 'salesforce'
    : gmailSnippets.length > 0 ? 'gmail'
    : 'none'

  if (signalSource === 'none') {
    return noDataResult(customer)
  }

  // 3. Build prompt and call Claude
  const prompt = buildClassificationPrompt(customer, sfTasks, gmailSnippets)

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    system: CLASSIFICATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')

  const parsed = parseClassificationResponse(text)

  return {
    org_uuid: customer.org_uuid,
    company_name: customer.company_name,
    ...parsed,
    signal_source: signalSource,
    classified_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Classification prompt
// ---------------------------------------------------------------------------

const CLASSIFICATION_SYSTEM_PROMPT = `
You are an accounts receivable analyst. Your job is to classify why a customer has not paid
their invoice based on recent communication from their Salesforce activity log and/or emails
to the AR inbox.

Today's date is ${new Date().toISOString().slice(0, 10)}.

IMPORTANT — STALE PROMISES:
Each Salesforce task shows how many days ago it was logged. If a task from more than 14 days ago
says the customer "will pay next week", "will pay by end of month", or similar — and the invoice
is still unpaid — treat this as a BROKEN PROMISE, not a positive signal. Adjust collection_probability
downward and increase the risk_modifier accordingly. A promise made 30+ days ago with no payment
is a significant red flag.

Respond ONLY with a valid JSON object — no markdown, no preamble, no explanation.
The JSON must exactly match this shape:

{
  "dispute_category": "<one of the categories below>",
  "confidence": "high" | "medium" | "low",
  "collection_probability": "high" | "medium" | "low",
  "recommended_action": "<one of the actions below>",
  "summary": "<one sentence, max 20 words, for the AR rep>",
  "risk_modifier": <integer between -10 and 40>
}

DISPUTE CATEGORIES:
- cancellation_dispute         Customer claims they cancelled but was still billed or auto-renewed
- payment_method_failure       Card/bank/PayPal is failing; customer wants to pay but can't
- seat_pricing_dispute         Withholding payment pending seat reduction or pricing negotiation
- enterprise_ap_delay          Large enterprise in an internal approval queue; will pay
- auto_renewal_confusion       Customer unaware of auto-renewal terms; did not proactively cancel
- international_payment_barrier  Non-US bank; needs wire instructions or tax compliance documents
- product_dissatisfaction      Disputing payment because product didn't meet expectations
- billing_error                Invoice billed to wrong entity, wrong amount, or wrong period
- no_dispute_detected          Customer intends to pay; no blockers mentioned
- insufficient_data            Cannot determine reason from available signals

RECOMMENDED ACTIONS:
- send_payment_link            Resend a fresh payment link / new card entry
- loop_in_csm                  Escalate to Customer Success to handle dispute
- send_compliance_docs         Provide tax residency cert / NO PE cert / wire details
- schedule_followup            Add a follow-up reminder (AP queue, "will pay by end of week")
- escalate_legal               Contract dispute; loop in legal
- offer_seat_reduction         Initiate seat reduction via billing team to unblock payment
- clarify_auto_renewal         Explain auto-renewal policy; offer non-renewal going forward
- correct_invoice              Fix invoice error and resend
- standard_collections         No special action; continue normal collections
- no_action                    Resolved or no outstanding issue

RISK MODIFIER GUIDE:
- enterprise_ap_delay:           -10  (money is coming, lower the score)
- no_dispute_detected:            0
- payment_method_failure:        +10  (fixable, but stalled)
- auto_renewal_confusion:        +15
- seat_pricing_dispute:          +20
- billing_error:                 +15
- international_payment_barrier: +20
- product_dissatisfaction:       +30
- cancellation_dispute:          +35
`.trim()

function buildClassificationPrompt(
  customer: CustomerRecord,
  sfTasks: SalesforceTask[],
  gmailSnippets: GmailSnippet[]
): string {
  const lines: string[] = [
    `CUSTOMER: ${customer.company_name}`,
    `DAYS OVERDUE: ${customer.days_overdue}`,
    `AMOUNT DUE: ${customer.amount_due.toLocaleString()}`,
    `INVOICE COUNT: ${customer.open_invoice_count}`,
    '',
  ]

  if (sfTasks.length > 0) {
    lines.push('SALESFORCE ACTIVITY (most recent first):')
    sfTasks.slice(0, 5).forEach(t => {
      const age = daysSince(t.date)
      const ageLabel = age === 0 ? 'today' : age === 1 ? '1 day ago' : `${age} days ago`
      lines.push(`  [${t.date} — ${ageLabel}] ${t.type}: ${t.description}`)
    })
    lines.push('')
  }

  if (gmailSnippets.length > 0) {
    lines.push('RECENT AR INBOX EMAILS:')
    gmailSnippets.slice(0, 3).forEach(g => {
      lines.push(`  [${g.date}] From: ${g.from}`)
      lines.push(`  "${g.snippet}"`)
    })
    lines.push('')
  }

  lines.push('Classify this customer\'s non-payment reason. Return JSON only.')

  return lines.join('\n')
}

function parseClassificationResponse(text: string): Omit<DisputeClassification, 'org_uuid' | 'company_name' | 'signal_source' | 'classified_at'> {
  try {
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    // Fallback if Claude doesn't return valid JSON
    return {
      dispute_category: 'insufficient_data',
      confidence: 'low',
      collection_probability: 'medium',
      recommended_action: 'standard_collections',
      summary: 'Could not parse classification response.',
      risk_modifier: 0,
    }
  }
}

function noDataResult(customer: CustomerRecord): DisputeClassification {
  return {
    org_uuid: customer.org_uuid,
    company_name: customer.company_name,
    dispute_category: 'insufficient_data',
    confidence: 'low',
    collection_probability: 'medium',
    recommended_action: 'standard_collections',
    summary: 'No recent communication found in Salesforce or Gmail.',
    risk_modifier: 0,
    signal_source: 'none',
    classified_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Data fetchers — wire these to your actual sources
// ---------------------------------------------------------------------------

async function loadOpenBalanceCustomers(): Promise<CustomerRecord[]> {
  const csvPath = path.join(process.cwd(), 'data', 'upflow-export.csv')
  const raw = await fs.readFile(csvPath, 'utf-8')
  const { data: rows } = Papa.parse<Record<string, string>>(raw.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim().replace(/^\uFEFF/, ''),
    transform: v => v.trim(),
  })

  // Group rows by customer name — same logic as AR360.tsx buildCustomers
  const map: Record<string, {
    name: string
    orgUuid: string
    emailDomain: string
    invoices: { outstanding: number; daysOverdue: number }[]
  }> = {}

  const cols = rows[0] ? Object.keys(rows[0]) : []
  const emailCols = cols.filter(k => k.toLowerCase().includes('email'))

  for (const r of rows) {
    const name = r['Customer Name'] || 'Unknown'
    if (!map[name]) {
      // Extract email domain
      let domain = ''
      for (const k of emailCols) {
        const val = (r[k] || '').split('@')[1]?.toLowerCase().trim()
        if (val) { domain = val; break }
      }

      map[name] = {
        name,
        orgUuid: r['Organization UUID'] || '',
        emailDomain: domain,
        invoices: [],
      }
    }

    const outstanding = parseFloat((r['Amount Outstanding'] || '0').replace(/[^0-9.\-]/g, '')) || 0
    const daysOverdue = parseInt((r['Days Overdue'] || '0').replace(/[^0-9\-]/g, '')) || 0
    map[name].invoices.push({ outstanding, daysOverdue })
  }

  return Object.values(map)
    .filter(c => c.invoices.some(i => i.outstanding > 0))
    .map(c => ({
      org_uuid: c.orgUuid,
      company_name: c.name,
      domain: c.emailDomain,
      days_overdue: Math.max(0, ...c.invoices.map(i => i.daysOverdue)),
      amount_due: c.invoices.reduce((s, i) => s + i.outstanding, 0),
      open_invoice_count: c.invoices.filter(i => i.outstanding > 0).length,
    }))
    .sort((a, b) => b.amount_due - a.amount_due)
}

// Cache parsed SF tasks so we only read/parse the CSV once per invocation
let sfTasksCache: Record<string, SalesforceTask[]> | null = null

async function loadSfTasksCache(): Promise<Record<string, SalesforceTask[]>> {
  if (sfTasksCache) return sfTasksCache

  const csvPath = path.join(process.cwd(), 'data', 'sf-tasks.csv')
  const raw = await fs.readFile(csvPath, 'utf-8')
  const { data: rows } = Papa.parse<Record<string, string>>(raw.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim().replace(/^\uFEFF/, ''),
    transform: v => v.trim(),
  })

  // Dynamically find the UUID column — same logic as AR360.tsx buildTasksIndex
  const cols = rows[0] ? Object.keys(rows[0]) : []
  const idCol = cols.find(k => /organization_uuid/i.test(k))
    || cols.find(k => /uuid/i.test(k))
    || cols.find(k => /accountid/i.test(k))
    || ''

  // Find date column
  const dateCol = cols.find(k => /^activitydate$/i.test(k))
    || cols.find(k => /^createddate$/i.test(k))
    || cols.find(k => /date/i.test(k))
    || ''

  // Find type column
  const typeCol = cols.find(k => /^tasksubtype$/i.test(k))
    || cols.find(k => /^type$/i.test(k))
    || ''

  // Find description column(s)
  const subjectCol = cols.find(k => /^subject$/i.test(k)) || ''
  const descCol = cols.find(k => /^description$/i.test(k)) || ''

  const map: Record<string, SalesforceTask[]> = {}
  for (const r of rows) {
    const key = (r[idCol] || '').trim()
    if (!key) continue

    const task: SalesforceTask = {
      org_uuid: key,
      date: r[dateCol] || '',
      type: (r[typeCol] || 'Note') as SalesforceTask['type'],
      description: [r[subjectCol], r[descCol]].filter(Boolean).join(' — '),
    }

    if (!map[key]) map[key] = []
    map[key].push(task)
  }

  // Sort each customer's tasks most-recent-first
  for (const tasks of Object.values(map)) {
    tasks.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  }

  sfTasksCache = map
  return map
}

async function fetchSalesforceTasks(orgUuid: string): Promise<SalesforceTask[]> {
  try {
    const map = await loadSfTasksCache()
    return map[orgUuid] || []
  } catch {
    return []
  }
}

async function fetchGmailSnippets(domain: string): Promise<GmailSnippet[]> {
  // Requires GMAIL_REFRESH_TOKEN env var — a refresh token with Gmail read scope
  // for the accountsreceivable@pandadoc.com mailbox
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN
  if (!refreshToken) return []

  try {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    )
    oauth2.setCredentials({ refresh_token: refreshToken })

    const gmail = google.gmail({ version: 'v1', auth: oauth2 })
    const MAILBOX = process.env.GMAIL_AR_MAILBOX || 'accountsreceivable@pandadoc.com'

    const listRes = await gmail.users.messages.list({
      userId: MAILBOX,
      q: `from:@${domain}`,
      maxResults: 5,
    })

    const messageIds = listRes.data.messages || []
    if (!messageIds.length) return []

    const snippets: GmailSnippet[] = []
    for (const msg of messageIds.slice(0, 3)) {
      const detail = await gmail.users.messages.get({
        userId: MAILBOX,
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'Date'],
      })

      const headers = detail.data.payload?.headers || []
      const from = headers.find(h => h.name === 'From')?.value || ''
      const date = headers.find(h => h.name === 'Date')?.value || ''

      snippets.push({
        date: date ? new Date(date).toISOString().slice(0, 10) : '',
        from,
        snippet: detail.data.snippet || '',
      })
    }

    return snippets
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Stub types — replace with your actual AR360 types
// ---------------------------------------------------------------------------

interface CustomerRecord {
  org_uuid: string
  company_name: string
  domain: string
  days_overdue: number
  amount_due: number
  open_invoice_count: number
}

interface SalesforceTask {
  org_uuid: string
  date: string
  type: 'Call' | 'Email' | 'Meeting' | 'Note'
  description: string
}

interface GmailSnippet {
  date: string
  from: string
  snippet: string
}
