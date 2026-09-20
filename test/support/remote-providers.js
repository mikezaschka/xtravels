/**
 * Starts the services xtravels federates from as *real server processes*, so
 * tests exercise the wire: CQN serialized over HCQL, and OData V2/V4 URLs with
 * `$filter` / `$select` / `$top` / `$skip` / `$count`.
 *
 * The app's other suites mock these remotes in-process (`--with-mocks`), which
 * is fast but bypasses protocol translation entirely — the layer where
 * federation actually earns its keep.
 *
 *   xflights     HCQL      ../xflights            (the capire/xflights app)
 *   S/4          odata     test/providers/s4      (@capire/s4's API, V4 and V2,
 *                odata-v2                           seeded with organizations)
 *   HotelsService odata     test/providers/hotels  (this app's own microservice)
 *
 * xflights and s4 are expected next to this repo, as described in the readme's
 * "Using Workspaces" setup. When they are missing, `hasSiblingRepos()` is false
 * and the suites skip rather than fail.
 */
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')
const cds = require('@sap/cds')

const ROOT = path.join(__dirname, '../..')
const XFLIGHTS_DIR = path.join(ROOT, '../xflights')
const S4_DIR = path.join(ROOT, '../s4')
const S4_DIR_PROVIDER = path.join(ROOT, 'test/providers/s4')
const HOTELS_DIR = path.join(ROOT, 'test/providers/hotels')

function hasSiblingRepos() {
    return fs.existsSync(path.join(XFLIGHTS_DIR, 'package.json'))
        && fs.existsSync(path.join(S4_DIR, 'package.json'))
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.listen(0, () => {
            const { port } = server.address()
            server.close(err => (err ? reject(err) : resolve(port)))
        })
        server.on('error', reject)
    })
}

function startServer(name, dir, args, port) {
    return new Promise((resolve, reject) => {
        const proc = spawn('npx', [...args, '--port', String(port)], {
            cwd: dir,
            env: {
                ...process.env,
                CDS_ENV: 'development',
                // Keep out of the shared ~/.cds-services.json registry: a stale
                // entry there makes `cds mock` skip mocking the service.
                CDS_CONFIG: JSON.stringify({ no_bindings: true }),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        let output = ''
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            reject(new Error(`${name} did not start within 60s:\n${output}`))
        }, 60000)

        const onData = data => {
            output += data.toString()
            if (settled || !output.includes('server listening')) return
            settled = true
            clearTimeout(timer)
            resolve(proc)
        }
        proc.stdout.on('data', onData)
        proc.stderr.on('data', onData)
        proc.on('error', err => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(new Error(`${name} failed to start: ${err.message}`))
        })
        proc.on('exit', code => {
            if (settled || code === 0 || code === null) return
            settled = true
            clearTimeout(timer)
            reject(new Error(`${name} exited with ${code}:\n${output}`))
        })
    })
}

// CAP resolves `cds.requires` when it builds cds.env, adding `impl` and
// `external: true` to anything with credentials. A binding assigned afterwards
// skips that step, so a service the app also serves locally (xtravels serves
// HotelsService itself) would silently resolve to the *local* one and never
// touch the network. Spell the resolved shape out.
const REMOTE_IMPL = '@sap/cds/srv/remote-service.js'
const remote = (kind, url) => ({ impl: REMOTE_IMPL, external: true, kind, credentials: { url } })

const running = []
let flightsProcess = null
let hotelsProcess = null

/**
 * @param {object} [options]
 * @param {'v4'|'v2'} [options.s4='v4'] which protocol to bind the S/4 API with.
 *   xtravels' own [production] profile uses V2, so both are worth covering.
 * @returns {Promise<{flights:number, s4:number, hotels:number}>} the ports in use
 */
async function startRemotes({ s4 = 'v4' } = {}) {
    const [flightsPort, s4Port, hotelsPort] = await Promise.all([freePort(), freePort(), freePort()])

    // One provider serves both protocols; only the bound URL differs.
    const s4Server = startServer('s4', S4_DIR_PROVIDER, ['cds', 'mock', 'API_BUSINESS_PARTNER'], s4Port)

    const started = await Promise.all([
        startServer('xflights', XFLIGHTS_DIR, ['cds-serve'], flightsPort),
        s4Server,
        startServer('hotels', HOTELS_DIR, ['cds', 'mock', 'sap.capire.hotels.HotelsService'], hotelsPort),
    ])
    flightsProcess = started[0]
    hotelsProcess = started[2]
    running.push(...started)

    const requires = (cds.env.requires ||= {})
    requires['sap.capire.flights.FlightsService'] = remote('hcql', `http://localhost:${flightsPort}/hcql/flights`)
    // Path differs per project: @capire/s4 exposes its own `business-partner`
    // service, while the V2 launcher mocks the imported API_BUSINESS_PARTNER.
    const s4Binding = s4 === 'v2'
        ? remote('odata-v2', `http://localhost:${s4Port}/odata/v2/api-business-partner`)
        : remote('odata', `http://localhost:${s4Port}/odata/v4/api-business-partner`)
    requires['sap.capire.hotels.HotelsService'] = remote('odata', `http://localhost:${hotelsPort}/odata/v4/hotels`)
    requires['sap.capire.s4.business-partner'] = s4Binding
    // @capire/s4 maps the logical name onto the imported service definition.
    requires.API_BUSINESS_PARTNER = s4Binding

    return { flights: flightsPort, s4: s4Port, hotels: hotelsPort }
}

function terminate(proc) {
    return new Promise(resolve => {
        proc.on('exit', () => resolve())
        proc.kill('SIGTERM')
        setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { /* already gone */ }
            resolve()
        }, 5000)
    })
}

/**
 * Stops xflights only — for proving that a cached read survives the remote
 * being unreachable. Whatever runs after this must not need it.
 */
async function stopFlights() {
    if (!flightsProcess) return
    await terminate(flightsProcess)
    running.splice(running.indexOf(flightsProcess), 1)
    flightsProcess = null
}

/** Same, for the hotels microservice. */
async function stopHotels() {
    if (!hotelsProcess) return
    await terminate(hotelsProcess)
    running.splice(running.indexOf(hotelsProcess), 1)
    hotelsProcess = null
}

async function stopRemotes() {
    await Promise.all(running.map(terminate))
    running.length = 0
    flightsProcess = null
    hotelsProcess = null
}

module.exports = { hasSiblingRepos, startRemotes, stopRemotes, stopFlights, stopHotels }
