import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { deletePrinter, getPrinterById, listDailyAnalytics, listPrinters, resetDailyAnalytics, upsertPrinter } from './server/postgres.js'

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

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))

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
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },
  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
  }
})
