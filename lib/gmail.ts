import { google } from 'googleapis'

function getOAuth2Client(accessToken: string, refreshToken: string) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  client.setCredentials({ access_token: accessToken, refresh_token: refreshToken })
  return client
}

function makeRfc2822(to: string, from: string, subject: string, body: string): string {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join('\r\n')
}

function encodeRfc2822(raw: string): string {
  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export async function createDraft(
  accessToken: string,
  refreshToken: string,
  to: string,
  from: string,
  subject: string,
  body: string,
) {
  const auth = getOAuth2Client(accessToken, refreshToken)
  const gmail = google.gmail({ version: 'v1', auth })
  const raw = encodeRfc2822(makeRfc2822(to, from, subject, body))
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  })
  return res.data
}

export async function sendDraft(accessToken: string, refreshToken: string, draftId: string) {
  const auth = getOAuth2Client(accessToken, refreshToken)
  const gmail = google.gmail({ version: 'v1', auth })
  const res = await gmail.users.drafts.send({
    userId: 'me',
    requestBody: { id: draftId },
  })
  return res.data
}

export async function sendEmail(
  accessToken: string,
  refreshToken: string,
  to: string,
  from: string,
  subject: string,
  body: string,
) {
  const auth = getOAuth2Client(accessToken, refreshToken)
  const gmail = google.gmail({ version: 'v1', auth })
  const raw = encodeRfc2822(makeRfc2822(to, from, subject, body))
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  })
  return res.data
}
