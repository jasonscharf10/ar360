/**
 * Recurly API client for AR360.
 * Fetches open and past-due charge invoices and maps them to CustomerRecord objects.
 * Account Code in Recurly = Organization UUID in PandaDoc.
 */

const RECURLY_BASE = 'https://v3.recurly.com'
const RECURLY_VERSION = 'application/vnd.recurly.v2021-02-25'

function headers(): HeadersInit {
  const apiKey = process.env.RECURLY_API_KEY
  if (!apiKey) throw new Error('RECURLY_API_KEY is not set')
  return {
    'Authorization': `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    'Accept': RECURLY_VERSION,
    'Accept-Language': 'en-US',
  }
}

interface RecurlyInvoice {
  id: string
  number: string
  state: string
  type: string
  currency: string
  total: number
  paid: number
  balance: number | null  // may be absent in some API versions
  created_at: string
  due_at: string | null
  collection_method: string
  account: {
    id: string
    code: string
    company: string | null
    email: string | null
    first_name: string | null
    last_name: string | null
  }
}

async function fetchInvoicesByState(state: string): Promise<RecurlyInvoice[]> {
  const invoices: RecurlyInvoice[] = []
  let nextUrl: string | null = `${RECURLY_BASE}/invoices?state=${state}&limit=200&order=desc&sort=created_at`
  let pages = 0

  while (nextUrl && pages < 20) {
    pages++
    const res = await fetch(nextUrl, { headers: headers() })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Recurly API error ${res.status}: ${body}`)
    }

    const data: { data: RecurlyInvoice[]; has_more: boolean; next: string | null } = await res.json()
    if (!Array.isArray(data.data)) {
      throw new Error(`Unexpected Recurly response for state=${state}: ${JSON.stringify(data).slice(0, 200)}`)
    }
    invoices.push(...data.data)

    if (data.has_more && data.next) {
      nextUrl = data.next.startsWith('http') ? data.next : `${RECURLY_BASE}${data.next}`
    } else {
      nextUrl = null
    }
  }

  return invoices
}

export interface InvoiceRecord {
  number: string
  outstanding: number
  issueDate: string
  dueDate: string
  daysOverdue: number
  state: string
  workflow: string
}

export interface CustomerRecord {
  name: string
  accountName: string
  externalId: string
  organizationUuid: string
  accountManager: string  // populated later from Salesforce/Snowflake
  currency: string
  email: string
  emailDomain: string
  invoices: InvoiceRecord[]
  totalOutstanding: number
  maxDaysOverdue: number
}

function daysSince(dateStr: string): number {
  if (!dateStr) return 0
  return Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000))
}

function domainOf(email: string | null | undefined): string {
  return (email || '').split('@')[1]?.toLowerCase().trim() || ''
}

// Cache Recurly results for 5 minutes to avoid slow repeat loads
const g = global as any
if (!g.__recurlyCache) g.__recurlyCache = { data: null, at: 0 }
const CACHE_TTL_MS = 5 * 60 * 1000

export async function fetchOpenCustomers(): Promise<CustomerRecord[]> {
  const now = Date.now()
  if (g.__recurlyCache.data && now - g.__recurlyCache.at < CACHE_TTL_MS) {
    return g.__recurlyCache.data
  }

  const [pastDue, failed] = await Promise.all([
    fetchInvoicesByState('past_due'),
    fetchInvoicesByState('failed'),
  ])

  const allInvoices = [...pastDue, ...failed]

  // Deduplicate by invoice id, group by account code (= org_uuid)
  const seen = new Set<string>()
  const byAccount: Record<string, { account: RecurlyInvoice['account']; invoices: RecurlyInvoice[] }> = {}

  for (const inv of allInvoices) {
    if (seen.has(inv.id)) continue
    seen.add(inv.id)

    const key = inv.account.code
    if (!key) continue
    if (!byAccount[key]) byAccount[key] = { account: inv.account, invoices: [] }
    byAccount[key].invoices.push(inv)
  }

  const customers = Object.values(byAccount)
    .map(({ account, invoices }) => {
      const mapped: InvoiceRecord[] = invoices.map(inv => ({
        number: inv.number,
        outstanding: inv.balance ?? (inv.total - (inv.paid ?? 0)),
        issueDate: inv.created_at.slice(0, 10),
        dueDate: inv.due_at ? inv.due_at.slice(0, 10) : '',
        daysOverdue: inv.due_at ? daysSince(inv.due_at) : 0,
        state: inv.state,
        workflow: inv.collection_method,
      }))

      const totalOutstanding = mapped.reduce((s, i) => s + i.outstanding, 0)
      const maxDaysOverdue = Math.max(0, ...mapped.map(i => i.daysOverdue))

      const name =
        account.company ||
        [account.first_name, account.last_name].filter(Boolean).join(' ') ||
        account.email ||
        account.code

      return {
        name,
        accountName: name,
        externalId: account.id,
        organizationUuid: account.code,
        accountManager: '',
        currency: invoices[0]?.currency || 'USD',
        email: account.email || '',
        emailDomain: domainOf(account.email),
        invoices: mapped,
        totalOutstanding,
        maxDaysOverdue,
      }
    })
    .filter(c => c.totalOutstanding > 0)
    .sort((a, b) => b.totalOutstanding - a.totalOutstanding)

  g.__recurlyCache = { data: customers, at: Date.now() }
  return customers
}
