import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import * as fs from 'fs/promises'
import * as path from 'path'

export async function GET(req: NextRequest) {
  const cronSecret = req.headers.get('x-cron-secret')
  const session = await getServerSession(authOptions)
  if (!session && cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const filePath = path.join(process.cwd(), 'data', 'dispute-classifications.json')
    const raw = await fs.readFile(filePath, 'utf-8')
    return NextResponse.json(JSON.parse(raw))
  } catch {
    return NextResponse.json({ results: [], count: 0 })
  }
}
