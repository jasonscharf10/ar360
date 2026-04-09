/**
 * GET /api/customers
 * Returns all customers with open balances, fetched live from Recurly.
 * Requires an active session (NextAuth).
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { fetchOpenCustomers } from '@/lib/recurly'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const customers = await fetchOpenCustomers()
    return NextResponse.json({ customers })
  } catch (err) {
    console.error('[/api/customers] fetch failed:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
