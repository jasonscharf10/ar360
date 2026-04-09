/**
 * Salesforce REST API client for AR360.
 * Fetches Account Owner (account manager) by Organization_UUID__c.
 * Uses SOAP login — no Connected App required, only username/password/security token.
 *
 * NOTE: The custom field API name is assumed to be Organization_UUID__c.
 * If your org uses a different API name for the "Organization UUID" field,
 * update SF_ORG_UUID_FIELD below.
 */

const SF_SOAP_LOGIN = 'https://login.salesforce.com/services/Soap/u/59.0'
const SF_API_VERSION = 'v59.0'
const SF_ORG_UUID_FIELD = 'Organization_UUID__c'

interface SalesforceToken {
  access_token: string
  instance_url: string
  expires_at: number
}

let cachedToken: SalesforceToken | null = null

async function getToken(): Promise<SalesforceToken> {
  if (cachedToken && Date.now() < cachedToken.expires_at) return cachedToken

  const required = ['SF_USERNAME', 'SF_PASSWORD', 'SF_SECURITY_TOKEN']
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`)
  }

  const username = process.env.SF_USERNAME!
  const password = process.env.SF_PASSWORD! + process.env.SF_SECURITY_TOKEN!

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>${username}</urn:username>
      <urn:password>${password}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>`

  const res = await fetch(SF_SOAP_LOGIN, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' },
    body: soapBody,
  })

  const xml = await res.text()
  if (!res.ok) throw new Error(`Salesforce login failed (${res.status}): ${xml.slice(0, 300)}`)

  const sessionIdMatch = xml.match(/<sessionId>([^<]+)<\/sessionId>/)
  const serverUrlMatch = xml.match(/<serverUrl>([^<]+)<\/serverUrl>/)
  if (!sessionIdMatch || !serverUrlMatch) {
    throw new Error(`Salesforce login response missing sessionId/serverUrl: ${xml.slice(0, 300)}`)
  }

  const instanceUrl = new URL(serverUrlMatch[1]).origin
  // SOAP sessions last ~2 hours; cache for 1h45m to be safe
  cachedToken = { access_token: sessionIdMatch[1], instance_url: instanceUrl, expires_at: Date.now() + 105 * 60 * 1000 }
  return cachedToken
}

async function soqlQuery(
  instanceUrl: string,
  accessToken: string,
  soql: string
): Promise<any[]> {
  const url = `${instanceUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`
  const records: any[] = []

  let nextUrl: string | null = url
  while (nextUrl) {
    const res: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Salesforce query failed (${res.status}): ${body}`)
    }
    const data: any = await res.json()
    records.push(...(data.records ?? []))
    nextUrl = data.nextRecordsUrl
      ? `${instanceUrl}${data.nextRecordsUrl}`
      : null
  }

  return records
}

/**
 * Returns a map of organizationUuid → account manager name for all provided UUIDs.
 * Batches queries to stay within SOQL IN-clause limits.
 */
export async function fetchAccountManagers(
  orgUuids: string[]
): Promise<Record<string, string>> {
  if (!orgUuids.length) return {}

  const { access_token, instance_url } = await getToken()
  const result: Record<string, string> = {}
  const BATCH = 500

  for (let i = 0; i < orgUuids.length; i += BATCH) {
    const batch = orgUuids.slice(i, i + BATCH)
    const inList = batch.map(id => `'${id.replace(/'/g, "\\'")}'`).join(',')
    const soql = `SELECT ${SF_ORG_UUID_FIELD}, Owner.Name FROM Account WHERE ${SF_ORG_UUID_FIELD} IN (${inList})`

    const records = await soqlQuery(instance_url, access_token, soql)
    for (const r of records) {
      const uuid = r[SF_ORG_UUID_FIELD]
      const owner = r.Owner?.Name
      if (uuid && owner) result[uuid] = owner
    }
  }

  return result
}
