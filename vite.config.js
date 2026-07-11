import { defineConfig, loadEnv } from 'vite'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createDiscordWebhook, deleteDiscordWebhook, deletePrinter, deleteQueueJob, getPrinterById, listDailyAnalytics, listDiscordWebhooks, listPrinters, listQueueData, markQueueJobPrinted, resetDailyAnalytics, resetQueueJobs, upsertPrinter, upsertQueueJobs } from './server/postgres.js'

function getGoogleSheetId(sheetUrl) {
  const match = sheetUrl.match(/\/spreadsheets\/d\/([^/]+)/)
  if (!match) {
    throw new Error('Invalid Google Sheet URL')
  }

  return match[1]
}

function toGoogleSheetCsvUrl(sheetUrl) {
  return `https://docs.google.com/spreadsheets/d/${getGoogleSheetId(sheetUrl)}/gviz/tq?tqx=out:csv`
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = ''

    req.on('data', (chunk) => {
      rawBody += chunk
    })

    req.on('end', () => {
      try {
        resolve(rawBody ? JSON.parse(rawBody) : {})
      } catch (error) {
        reject(error)
      }
    })

    req.on('error', reject)
  })
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []

    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })

    req.on('error', reject)
  })
}

function parseHeaderString(headerValue) {
  const separatorIndex = headerValue.indexOf(':')
  if (separatorIndex === -1) {
    const trimmedValue = headerValue.trim()
    return trimmedValue ? { 'X-API-Key': trimmedValue } : {}
  }

  const name = headerValue.slice(0, separatorIndex).trim()
  const value = headerValue.slice(separatorIndex + 1).trim()

  return name && value ? { [name]: value } : {}
}

function parseCsv(csvText) {
  const rows = []
  let currentRow = []
  let currentValue = ''
  let insideQuotes = false

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index]
    const nextCharacter = csvText[index + 1]

    if (character === '"') {
      if (insideQuotes && nextCharacter === '"') {
        currentValue += '"'
        index += 1
      } else {
        insideQuotes = !insideQuotes
      }
      continue
    }

    if (character === ',' && !insideQuotes) {
      currentRow.push(currentValue)
      currentValue = ''
      continue
    }

    if ((character === '\n' || character === '\r') && !insideQuotes) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1
      }

      currentRow.push(currentValue)
      currentValue = ''

      if (currentRow.some((cell) => cell.trim() !== '')) {
        rows.push(currentRow)
      }

      currentRow = []
      continue
    }

    currentValue += character
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue)
    if (currentRow.some((cell) => cell.trim() !== '')) {
      rows.push(currentRow)
    }
  }

  return rows
}

function normalizeSubmittedAt(value) {
  if (!value) return undefined

  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/)
  if (!match) {
    const fallback = new Date(value)
    return Number.isNaN(fallback.getTime()) ? undefined : fallback.toISOString()
  }

  const [, month, day, year, hour, minute, second] = match
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function isoTimestamp() {
  return new Date().toISOString()
}

function buildQueueAddedEmbed(job) {
  const fields = [
    { name: 'Submitter', value: job.submitterName || 'Unknown', inline: true },
    { name: 'Numbers', value: String(job.fileCount ?? 1), inline: true },
  ]

  if (job.notes) {
    fields.push({ name: 'Notes', value: String(job.notes).slice(0, 1024), inline: false })
  }

  if (job.stlFileUrl) {
    fields.push({ name: 'File', value: job.stlFileUrl, inline: false })
  }

  return {
    title: 'New Queue Submission',
    description: job.filename || job.id,
    color: 0x3B82F6,
    fields,
    timestamp: isoTimestamp(),
  }
}

async function sendQueueAddedNotifications(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return
  }

  const webhooks = await listDiscordWebhooks()
  if (webhooks.length === 0) {
    return
  }

  for (const job of jobs) {
    const embed = buildQueueAddedEmbed(job)
    await Promise.allSettled(
      webhooks
        .filter((webhook) => webhook.webhookUrl)
        .map((webhook) =>
          fetch(webhook.webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              username: 'PrintFarm Bot',
              embeds: [embed],
            }),
          }).then((response) => {
            if (!response.ok) {
              throw new Error(`Discord webhook failed with ${response.status}`)
            }
          }),
        ),
    )
  }
}

function mapSheetRowsToQueue(rows) {
  return rows
    .slice(1)
    .map((row, index) => {
      const formType = row[4]?.trim()
      if (formType !== 'สั่งพิมพ์งาน 3D Print') {
        return null
      }

      const submittedAt = normalizeSubmittedAt(row[0]?.trim())
      const studentId = row[1]?.trim()
      const firstName = row[2]?.trim()
      const lastName = row[3]?.trim()
      const course = row[5]?.trim()
      const notes = row[6]?.trim()
      const quantity = Number.parseInt(row[7]?.trim() || '1', 10)
      const fileUrl = row[8]?.trim()
      const submitterName = [firstName, lastName].filter(Boolean).join(' ').trim()
      const fileLabel = fileUrl
        ? `Google Drive File ${index + 1}`
        : `Sheet Submission ${index + 1}`
      const noteParts = [studentId ? `Student ID: ${studentId}` : '', course ? `Course: ${course}` : '', notes || '']
        .filter(Boolean)
      const estimatedTime = Math.max(30, Number.isFinite(quantity) ? quantity * 60 : 60)
      // Stable identity keyed by form timestamp + student id (see server/app.js).
      const idSource =
        submittedAt || studentId
          ? `${submittedAt ?? ''}|${studentId ?? ''}`
          : row.map((value) => value ?? '').join('|')
      const id = `queue-${createHash('sha1').update(idSource).digest('hex').slice(0, 16)}`

      return {
        id,
        filename: fileLabel,
        fileCount: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        status: 'queued',
        progress: 0,
        estimatedTime,
        timeRemaining: estimatedTime,
        filamentUsed: 0,
        priority: quantity >= 3 ? 'high' : quantity >= 2 ? 'medium' : 'low',
        stlFileUrl: fileUrl || undefined,
        submitterName: submitterName || studentId || `Submission ${index + 1}`,
        notes: noteParts.join(' | ') || undefined,
        submittedAt,
        formType,
        printedStatus: 0,
      }
    })
    .filter((job) => job && (job.stlFileUrl || job.submitterName))
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
  const googleSheetQueueUrl = process.env.VITE_GOOGLE_SHEET_QUEUE_URL

  return {
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
    {
      name: 'postgres-printer-api',
      configureServer(server) {
        server.middlewares.use('/api/printers', async (req, res) => {
          try {
            if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
              const printers = await listPrinters()
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
              res.setHeader('Pragma', 'no-cache')
              res.setHeader('Expires', '0')
              res.setHeader('Surrogate-Control', 'no-store')
              res.end(JSON.stringify(printers))
              return
            }

            if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
              const payload = await readJsonBody(req)
              await upsertPrinter(payload)
              res.statusCode = 204
              res.end()
              return
            }

            if (req.method === 'DELETE' && req.url?.startsWith('/')) {
              const printerId = decodeURIComponent(req.url.slice(1))
              if (!printerId) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Missing printer id' }))
                return
              }
              await deletePrinter(printerId)
              res.statusCode = 204
              res.end()
              return
            }
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Printer database request failed',
              }),
            )
            return
          }

          res.statusCode = 404
          res.end()
        })
      },
    },
    {
      name: 'postgres-analytics-api',
      configureServer(server) {
        server.middlewares.use('/api/analytics/daily', async (req, res) => {
          try {
            if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
              const analytics = await listDailyAnalytics(7)
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
              res.setHeader('Pragma', 'no-cache')
              res.setHeader('Expires', '0')
              res.setHeader('Surrogate-Control', 'no-store')
              res.end(JSON.stringify(analytics))
              return
            }

            if (req.method === 'POST' && req.url === '/reset') {
              await resetDailyAnalytics()
              res.statusCode = 204
              res.end()
              return
            }
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Analytics request failed',
              }),
            )
            return
          }

          res.statusCode = 404
          res.end()
        })
      },
    },
    {
      name: 'google-sheet-queue-api',
      configureServer(server) {
        server.middlewares.use('/api/queue', async (req, res) => {
          try {
            if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
              if (!googleSheetQueueUrl) {
                throw new Error('VITE_GOOGLE_SHEET_QUEUE_URL is not configured')
              }

              const response = await fetch(toGoogleSheetCsvUrl(googleSheetQueueUrl), {
                headers: {
                  Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8',
                },
              })

              if (!response.ok) {
                throw new Error(`Google Sheet request failed with ${response.status}`)
              }

              const csv = await response.text()
              const jobs = mapSheetRowsToQueue(parseCsv(csv))
              const addedJobs = await upsertQueueJobs(jobs)
              sendQueueAddedNotifications(addedJobs).catch((error) => {
                console.error('Failed to send queue add notification', error)
              })
              const queueData = await listQueueData()

              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
              res.setHeader('Pragma', 'no-cache')
              res.setHeader('Expires', '0')
              res.setHeader('Surrogate-Control', 'no-store')
              res.end(JSON.stringify(queueData))
              return
            }

            if (req.method === 'POST' && req.url === '/reset') {
              await resetQueueJobs()
              res.statusCode = 204
              res.end()
              return
            }

            if (req.method === 'POST' && req.url?.endsWith('/printed')) {
              const jobId = decodeURIComponent(req.url.split('/')[1] ?? '')
              if (!jobId) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Missing queue job id' }))
                return
              }

              await markQueueJobPrinted(jobId)
              res.statusCode = 204
              res.end()
              return
            }

            if (req.method === 'DELETE' && req.url?.startsWith('/')) {
              const jobId = decodeURIComponent(req.url.slice(1))
              if (!jobId) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Missing queue job id' }))
                return
              }

              await deleteQueueJob(jobId)
              res.statusCode = 204
              res.end()
              return
            }
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Queue request failed',
              }),
            )
            return
          }

          res.statusCode = 404
          res.end()
        })
      },
    },
    {
      name: 'discord-webhook-api',
      configureServer(server) {
        server.middlewares.use('/api/notifications/discord-webhooks', async (req, res) => {
          try {
            if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
              const webhooks = await listDiscordWebhooks()
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
              res.setHeader('Pragma', 'no-cache')
              res.setHeader('Expires', '0')
              res.setHeader('Surrogate-Control', 'no-store')
              res.end(JSON.stringify(webhooks))
              return
            }

            if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
              const payload = await readJsonBody(req)
              await createDiscordWebhook(payload)
              res.statusCode = 204
              res.end()
              return
            }

            if (req.method === 'DELETE' && req.url?.startsWith('/')) {
              const webhookId = decodeURIComponent(req.url.slice(1))
              if (!webhookId) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Missing webhook id' }))
                return
              }

              await deleteDiscordWebhook(webhookId)
              res.statusCode = 204
              res.end()
              return
            }
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Discord webhook request failed',
              }),
            )
            return
          }

          res.statusCode = 404
          res.end()
        })
      },
    },
    {
      name: 'printer-reverse-proxy',
      configureServer(server) {
        server.middlewares.use('/__printer_proxy', async (req, res) => {
          const requestUrl = new URL(req.url ?? '/', 'http://localhost')
          const [, printerId, ...pathParts] = requestUrl.pathname.split('/')
          const printerPath = `/${pathParts.join('/')}${requestUrl.search}`

          if (!printerId) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing printer proxy target' }))
            return
          }

          try {
            const printer = await getPrinterById(printerId)
            if (!printer) {
              res.statusCode = 404
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Printer not found' }))
              return
            }

            const body =
              req.method && !['GET', 'HEAD'].includes(req.method)
                ? await readRawBody(req)
                : undefined

            const response = await fetch(`${printer.url}${printerPath}`, {
              method: req.method,
              headers: {
                ...parseHeaderString(printer.apiKeyHeader),
                ...Object.fromEntries(
                  Object.entries(req.headers).filter(([key]) =>
                    key !== 'host' && key !== 'connection' && key !== 'content-length'
                  ),
                ),
              },
              body: body && body.length > 0 ? body : undefined,
            })

            res.statusCode = response.status
            const contentType = response.headers.get('content-type')
            if (contentType) {
              res.setHeader('Content-Type', contentType)
            }

            res.end(Buffer.from(await response.arrayBuffer()))
          } catch (error) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Unable to reverse proxy printer request',
              }),
            )
          }
        })
      },
    },
    {
      name: 'printer-webcam-proxy',
      configureServer(server) {
        server.middlewares.use('/__printer_webcam', async (req, res) => {
          const requestUrl = new URL(req.url ?? '/', 'http://localhost')
          const [, printerId, ...pathParts] = requestUrl.pathname.split('/')
          const webcamPath = `/${pathParts.join('/')}${requestUrl.search}`

          if (!printerId) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing printer webcam target' }))
            return
          }

          try {
            const printer = await getPrinterById(printerId)
            if (!printer) {
              res.statusCode = 404
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Printer not found' }))
              return
            }

            const abortController = new AbortController()
            res.on('close', () => abortController.abort())
            res.on('error', () => abortController.abort())

            const response = await fetch(`${printer.url}/webcam${webcamPath}`, {
              signal: abortController.signal,
            })
            res.statusCode = response.status

            const contentType = response.headers.get('content-type')
            if (contentType) {
              res.setHeader('Content-Type', contentType)
            }

            res.setHeader('Cache-Control', 'no-store')

            // Pipe the body so an endless MJPEG stream flows frame-by-frame
            // instead of buffering forever in arrayBuffer().
            if (response.body) {
              const upstream = Readable.fromWeb(response.body)
              upstream.on('error', () => {
                if (!res.writableEnded) res.end()
              })
              upstream.pipe(res)
            } else {
              res.end()
            }
          } catch (error) {
            // A client navigating away aborts the fetch — expected, not an error.
            if (res.destroyed || res.headersSent) {
              return
            }
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Unable to proxy webcam request',
              }),
            )
          }
        })
      },
    },
  ],
  server: {
    host: '0.0.0.0',
    // Accept requests for any Host header (the site can be reached from any domain).
    allowedHosts: true,
  },
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('recharts') || id.includes('/d3-')) return 'charts'
          if (id.includes('@radix-ui')) return 'radix'
          // Only referenced via a dynamic import in statusLightSerial.ts —
          // keep it out of the eager vendor chunk so it loads on demand.
          if (id.includes('esptool-js')) return 'esptool'
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/scheduler/') ||
            id.includes('react-router')
          )
            return 'react-vendor'
          return 'vendor'
        },
      },
    },
  },
  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
  }
})
