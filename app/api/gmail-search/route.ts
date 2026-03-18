import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { google } from 'googleapis'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions) as any
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { query, maxResults = 5 } = await req.json()
  if (!query) {
    return NextResponse.json({ error: 'Missing query' }, { status: 400 })
  }

  try {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    )
    oauth2.setCredentials({ access_token: session.accessToken })

    const gmail = google.gmail({ version: 'v1', auth: oauth2 })

    // Search using the delegated access to the AR inbox
    const MAILBOX = process.env.GMAIL_AR_MAILBOX || 'me'
    const listRes = await gmail.users.messages.list({
      userId: MAILBOX,
      q: query,
      maxResults,
    })

    const messageIds = listRes.data.messages || []
    if (!messageIds.length) {
      return NextResponse.json({ emails: [] })
    }

    const emails = []
    for (const msg of messageIds) {
      const detail = await gmail.users.messages.get({
        userId: MAILBOX,
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Date', 'Subject'],
      })

      const headers = detail.data.payload?.headers || []
      const get = (name: string) => headers.find(h => h.name === name)?.value || ''
      const from = get('From')
      const to = get('To')
      const GROUP_INBOX = process.env.GMAIL_AR_MAILBOX || 'accountsreceivable@pandadoc.com'
      const direction = from.toLowerCase().includes(GROUP_INBOX.split('@')[0]) ? 'outbound' : 'inbound'

      emails.push({
        date: get('Date'),
        from,
        to,
        subject: get('Subject'),
        snippet: detail.data.snippet || '',
        direction,
      })
    }

    return NextResponse.json({ emails })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Gmail search failed' }, { status: 500 })
  }
}
