const cds = require('@sap/cds')
const xtravels = cds.utils.path.join(__dirname, '..')
const { GET, POST, expect, defaults } = cds.test(xtravels, '--with-mocks')
defaults.auth = { username: 'alice' }

/**
 * The three consumption views annotated with @federation.replicate:
 *
 *   sap.capire.xflights.Flights      ← FlightsService.Flights      (delta)
 *   sap.capire.xflights.Supplements  ← FlightsService.Supplements  (delta)
 *   sap.capire.s4.Customers          ← S/4 A_BusinessPartner       (full)
 *
 * These replace the hand-written replication that upstream keeps in
 * srv/data-federation.js. Every entity gets its own describe: the local table
 * is really filled, the projection (renames, flattened paths, static where) is
 * applied, and the app's own entities read from the replica.
 *
 * Remotes are mocked in-process here, as in upstream's own tests. The
 * protocol-level suite (complex $filter/$expand over real OData and HCQL
 * servers) lives in the cds-data monorepo under
 * packages/cds-data-federation/test/integration/xtravels/.
 */
describe('@federation.replicate', () => {

    const execute = (name, mode) => POST('/pipeline/execute', mode ? { name, mode } : { name })

    describe('Pipelines derived from the annotations', () => {

        // Entity caches run on the same engine and show up here too, under
        // `data-federation-cache:<entity>` — filter them out.
        const replicatePipelines = async () => {
            const { data } = await GET('/pipeline/Pipelines?$select=name,mode,enabled&$orderby=name')
            return data.value.filter(p => !p.name.startsWith('data-federation-cache:'))
        }

        it('registers one pipeline per annotated consumption view', async () => {
            const pipelines = await replicatePipelines()
            expect(pipelines.map(p => p.name)).to.eql(['Customers', 'Flights', 'Supplements'])
            expect(pipelines.every(p => p.enabled)).to.be.true
        })

        it('infers delta mode from the annotation, full for Customers', async () => {
            const pipelines = await replicatePipelines()
            const mode = Object.fromEntries(pipelines.map(p => [p.name, p.mode]))
            expect(mode).to.eql({ Customers: 'full', Flights: 'delta', Supplements: 'delta' })
        })

        it('records a completed run per pipeline from the startup preload', async () => {
            const { data } = await GET(
                "/pipeline/PipelineRuns?$filter=trigger eq 'preload'&$select=pipeline_name,status,statistics_created",
            )
            expect(data.value).to.have.length(3)
            expect(data.value.every(r => r.status === 'completed')).to.be.true
            expect(data.value.every(r => r.statistics_created > 0)).to.be.true
        })
    })

    describe('Flights (delta on modifiedAt)', () => {

        it('fills the local table from the remote service', async () => {
            const rows = await SELECT.from('sap.capire.xflights.Flights')
            const remote = await SELECT.from('sap.capire.flights.FlightsService.Flights')
            expect(rows.length).to.equal(remote.length)
            expect(rows.length).to.be.greaterThan(0)
        })

        it('flattens the association paths declared in the projection', async () => {
            const flight = await SELECT.one.from('sap.capire.xflights.Flights').orderBy('ID')
            // airline.icon / airline.name / origin.name / destination.name
            expect(flight.airline).to.be.a('string').and.not.be.empty
            expect(flight.origin).to.be.a('string').and.not.be.empty
            expect(flight.destination).to.be.a('string').and.not.be.empty
            expect(flight.icon).to.be.a('string').and.not.be.empty
        })

        it('keeps only the projected columns', async () => {
            const flight = await SELECT.one.from('sap.capire.xflights.Flights')
            expect(flight).to.include.keys('ID', 'date', 'free_seats', 'price', 'modifiedAt')
            // not projected by the consumption view
            expect(flight).to.not.have.property('maximum_seats')
            expect(flight).to.not.have.property('occupied_seats')
            expect(flight).to.not.have.property('aircraft')
        })

        it('is served through the app as TravelService.Flights', async () => {
            const { data } = await GET('/odata/v4/travel/Flights?$top=2&$orderby=ID')
            expect(data.value).to.have.length(2)
            expect(data.value[0]).to.have.property('airline')
        })

        it('syncs only rows changed since the last run', async () => {
            const { ID, date } = await SELECT.one`ID, date`.from('sap.capire.xflights.Flights').orderBy('ID')

            const noop = await execute('Flights')
            expect(noop.status).to.equal(200)
            let { data: runs } = await GET(
                "/pipeline/PipelineRuns?$filter=pipeline_name eq 'Flights'&$orderby=startTime desc&$top=1",
            )
            expect(runs.value[0].statistics_created + runs.value[0].statistics_updated).to.equal(0)

            // Change one flight upstream, as ReserveSeats does in the real app.
            await UPDATE('sap.capire.flights.FlightsService.Flights')
                .set({ free_seats: 7, modifiedAt: new Date().toISOString() })
                .where({ ID, date })

            await execute('Flights')
            ;({ data: runs } = await GET(
                "/pipeline/PipelineRuns?$filter=pipeline_name eq 'Flights'&$orderby=startTime desc&$top=1",
            ))
            expect(runs.value[0].statistics_created + runs.value[0].statistics_updated).to.equal(1)

            const replica = await SELECT.one.from('sap.capire.xflights.Flights').where({ ID, date })
            expect(replica.free_seats).to.equal(7)
        })
    })

    describe('Supplements (delta on modifiedAt)', () => {

        it('fills the local table from the remote service', async () => {
            const rows = await SELECT.from('sap.capire.xflights.Supplements')
            const remote = await SELECT.from('sap.capire.flights.FlightsService.Supplements')
            expect(rows.length).to.equal(remote.length)
            expect(rows.length).to.be.greaterThan(0)
        })

        it('carries the projected columns including price and currency', async () => {
            const supplement = await SELECT.one.from('sap.capire.xflights.Supplements')
            expect(supplement).to.include.keys('ID', 'type', 'descr', 'price', 'currency_code', 'modifiedAt')
        })

        it('is served through the app as TravelService.Supplements', async () => {
            const { data } = await GET('/odata/v4/travel/Supplements?$top=1')
            expect(data.value).to.have.length(1)
        })
    })

    describe('Customers (full sync, static where, renames)', () => {

        it('fills the local table from the S/4 Business Partner API', async () => {
            const rows = await SELECT.from('sap.capire.s4.Customers')
            expect(rows.length).to.be.greaterThan(0)
        })

        it("applies the projection's static where — persons only", async () => {
            const replicated = await SELECT.from('sap.capire.s4.Customers')
            const persons = await SELECT.from('API_BUSINESS_PARTNER.A_BusinessPartner')
                .where({ BusinessPartnerCategory: '1' })
            expect(replicated.length).to.equal(persons.length)
        })

        it('never replicates organizations (category 2), only persons', async () => {
            // The shipped sample data is all persons, so the static `where`
            // needs a counter-example to actually prove anything: add one
            // organization and one person upstream, then re-run.
            await INSERT.into('API_BUSINESS_PARTNER.A_BusinessPartner').entries([
                { BusinessPartner: 'ORG001', PersonFullName: 'Acme Corp', BusinessPartnerCategory: '2' },
                { BusinessPartner: 'PER001', PersonFullName: 'Ada Lovelace', BusinessPartnerCategory: '1' },
            ])
            try {
                await execute('Customers')
                const ids = (await SELECT`ID`.from('sap.capire.s4.Customers')).map(c => c.ID)
                expect(ids).to.include('PER001')
                expect(ids).to.not.include('ORG001')
            } finally {
                await DELETE.from('API_BUSINESS_PARTNER.A_BusinessPartner')
                    .where({ BusinessPartner: { in: ['ORG001', 'PER001'] } })
                await DELETE.from('sap.capire.s4.Customers').where({ ID: { in: ['ORG001', 'PER001'] } })
            }
        })

        it('applies the renames declared in the projection', async () => {
            const customer = await SELECT.one.from('sap.capire.s4.Customers')
            // BusinessPartner as ID, PersonFullName as Name, LastChangeDate as modifiedAt
            expect(customer).to.include.keys('ID', 'Name', 'modifiedAt', 'modifiedAtTime')
            expect(customer).to.not.have.property('BusinessPartner')
            expect(customer).to.not.have.property('PersonFullName')
        })

        it('lets local Travels join the replica via $expand', async () => {
            const { data } = await GET(
                '/odata/v4/travel/Travels?$top=1&$filter=IsActiveEntity eq true&$select=ID&$expand=Customer($select=ID,Name)',
            )
            expect(data.value[0].Customer).to.have.property('Name')
        })

        it('re-reads every row on a full run', async () => {
            await execute('Customers')
            const { data } = await GET(
                "/pipeline/PipelineRuns?$filter=pipeline_name eq 'Customers'&$orderby=startTime desc&$top=1",
            )
            const rows = await SELECT.from('sap.capire.s4.Customers')
            expect(data.value[0].mode).to.equal('full')
            expect(data.value[0].statistics_created + data.value[0].statistics_updated).to.equal(rows.length)
        })
    })

    describe('Mashups: local data joined with the replicas', () => {

        it('expands local Travels into replicated Customers and Flights at once', async () => {
            const { status, data } = await GET(
                '/odata/v4/travel/Travels?$top=1&$filter=IsActiveEntity eq true&$select=ID'
                + '&$expand=Customer($select=ID,Name),Bookings($select=Pos;$expand=Flight($select=ID,airline,origin))',
            )
            expect(status).to.equal(200)
            const [travel] = data.value
            expect(travel.Customer).to.have.property('Name')          // S/4 replica
            expect(travel.Bookings.length).to.be.greaterThan(0)       // local composition
            expect(travel.Bookings[0].Flight).to.have.property('airline') // xflights replica
        })

        it('filters local Travels by a field that lives in the S/4 replica', async () => {
            const { Name } = await SELECT.one`Name`.from('sap.capire.s4.Customers')
                .where({ Name: { '!=': null } })
            const { status, data } = await GET(
                `/odata/v4/travel/Travels?$filter=IsActiveEntity eq true and Customer/Name eq '${Name}'&$select=ID&$count=true`,
            )
            expect(status).to.equal(200)
            // A join, not a second request: replication is what makes this possible.
            const expected = await SELECT.from('sap.capire.travels.Travels')
                .where`Customer_ID in ${SELECT`ID`.from('sap.capire.s4.Customers').where({ Name })}`
            expect(data['@odata.count']).to.equal(expected.length)
            expect(data.value.length).to.be.greaterThan(0)
        })

        it('orders local Travels by a replicated column', async () => {
            const { status, data } = await GET(
                '/odata/v4/travel/Travels?$filter=IsActiveEntity eq true&$top=5&$orderby=Customer/Name asc&$select=ID&$expand=Customer($select=Name)',
            )
            expect(status).to.equal(200)
            const names = data.value.map(t => t.Customer?.Name).filter(Boolean)
            expect(names).to.eql([...names].sort())
        })

        it('expands the other way: replicated Flights into local Bookings', async () => {
            const booking = await SELECT.one.from('sap.capire.travels.Bookings').where({ Flight_ID: { '!=': null } })
            const { Flight_ID, Flight_date } = booking
            const { status, data } = await GET(
                `/odata/v4/travel/Flights?$filter=ID eq '${Flight_ID}' and date eq ${Flight_date}`
                + '&$select=ID,airline&$expand=Bookings($select=Travel_ID,Pos)',
            )
            expect(status).to.equal(200)
            expect(data.value).to.have.length(1)
            expect(data.value[0].Bookings.length).to.be.greaterThan(0)
            // Flights are keyed by (ID, date), and so is the association.
            const expected = await SELECT.from('sap.capire.travels.Bookings').where({ Flight_ID, Flight_date })
            expect(data.value[0].Bookings.length).to.equal(expected.length)
        })

        it('aggregates local booking revenue grouped by a replicated airline', async () => {
            const { status, data } = await GET(
                '/odata/v4/travel/Bookings?$apply=groupby((Flight/airline),aggregate(FlightPrice with sum as total))',
            )
            expect(status).to.equal(200)
            const airlines = data.value.map(r => r.Flight?.airline).filter(Boolean)
            expect(airlines.length).to.be.greaterThan(1)
            expect(data.value.every(r => typeof r.total === 'number' || typeof r.total === 'string')).to.be.true

            // Same number the database gives for one group.
            const [first] = data.value.filter(r => r.Flight?.airline)
            const [{ sum }] = await SELECT`sum(b.FlightPrice) as sum`
                .from('sap.capire.travels.Bookings as b')
                .join('sap.capire.xflights.Flights as f').on`f.ID = b.Flight_ID and f.date = b.Flight_date`
                .where`f.airline = ${first.Flight.airline}`
            expect(Number(first.total)).to.equal(Number(sum))
        })
    })
})
