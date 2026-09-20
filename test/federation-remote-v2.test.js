const cds = require('@sap/cds')
const { hasSiblingRepos, startRemotes, stopRemotes } = require('./support/remote-providers')

/**
 * Same app, same annotations — but the S/4 Business Partner API is bound as
 * **OData V2**, which is what xtravels' own `[production]` profile configures
 * for a real S/4 system.
 *
 * V2 is a different protocol, not a dialect: `$filter` values, the `d.results`
 * envelope and `/Date(…)/` timestamps all differ, and `$count` is `$inlinecount`.
 * Replication that works over V4 can still break here, so the consumption
 * view's static `where`, its renames and its date columns are all re-checked.
 *
 * Needs ../xflights and ../s4; skips itself otherwise.
 */
const suite = hasSiblingRepos() ? describe : describe.skip

suite('federation against a real OData V2 remote (S/4)', () => {

    before(async () => {
        await startRemotes({ s4: 'v2' })
    })

    after(async () => {
        await stopRemotes()
    })

    const { GET, POST, expect, defaults } = cds.test(cds.utils.path.join(__dirname, '..'))
    defaults.auth = { username: 'alice', password: 'admin' }

    const S4 = 'API_BUSINESS_PARTNER.A_BusinessPartner'
    const s4Service = () => cds.connect.to('sap.capire.s4.business-partner')

    it('binds the S/4 API as odata-v2', () => {
        expect(cds.env.requires['sap.capire.s4.business-partner'].kind).to.equal('odata-v2')
        expect(cds.env.requires['sap.capire.s4.business-partner'].credentials.url).to.contain('/odata/v2/')
    })

    it('replicates the business partners over V2', async () => {
        const s4 = await s4Service()
        const remote = await s4.run(SELECT.from(S4).columns('BusinessPartner').where({ BusinessPartnerCategory: '1' }))
        const local = await SELECT.from('sap.capire.s4.Customers')
        expect(local.length).to.equal(remote.length)
        expect(local.length).to.be.greaterThan(0)
    })

    it("translates the view's `== '1'` into a V2 $filter", async () => {
        const s4 = await s4Service()
        await s4.run(INSERT.into(S4).entries(
            { BusinessPartner: 'ORG555', PersonFullName: 'Initech GmbH', BusinessPartnerCategory: '2' },
        ))
        await s4.run(INSERT.into(S4).entries(
            { BusinessPartner: 'PER555', PersonFullName: 'Katherine Johnson', BusinessPartnerCategory: '1' },
        ))
        try {
            const { status } = await POST('/pipeline/execute', { name: 'Customers' })
            expect(status).to.equal(200)
            const ids = (await SELECT`ID`.from('sap.capire.s4.Customers')).map(c => c.ID)
            expect(ids).to.include('PER555')
            expect(ids).to.not.include('ORG555')
        } finally {
            await s4.run(DELETE.from(S4, { BusinessPartner: 'ORG555' }))
            await s4.run(DELETE.from(S4, { BusinessPartner: 'PER555' }))
            await DELETE.from('sap.capire.s4.Customers').where({ ID: { in: ['ORG555', 'PER555'] } })
        }
    })

    it('maps renamed columns and V2 date/time values', async () => {
        const customer = await SELECT.one.from('sap.capire.s4.Customers').where({ modifiedAt: { '!=': null } })
        expect(customer).to.include.keys('ID', 'Name', 'modifiedAt', 'modifiedAtTime')
        expect(customer).to.not.have.property('PersonFullName')
        // V2 ships `/Date(1705622400000)/` on the wire; what lands locally must
        // be a plain date, not that serialization leaking through.
        expect(String(customer.modifiedAt)).to.not.contain('/Date(')
        expect(String(customer.modifiedAt)).to.match(/^\d{4}-\d{2}-\d{2}/)
    })

    it('serves the replicated customers through the app', async () => {
        const { status, data } = await GET(
            '/odata/v4/travel/Travels?$top=1&$filter=IsActiveEntity eq true&$select=ID&$expand=Customer($select=ID,Name)',
        )
        expect(status).to.equal(200)
        expect(data.value[0].Customer).to.have.property('Name')
    })

    it("delegates Organizations over V2, scoped by the view's `== '2'`", async () => {
        const { status, data } = await GET('/showcase/Organizations?$orderby=ID')
        expect(status).to.equal(200)
        const s4 = await s4Service()
        const companies = await s4.run(
            SELECT.from(S4).columns('BusinessPartner').where({ BusinessPartnerCategory: '2' }),
        )
        expect(companies.length).to.be.greaterThan(0)
        expect(data.value.map(o => o.ID)).to.eql(companies.map(c => c.BusinessPartner).sort())
        expect(data.value[0]).to.include.keys('ID', 'name')
        expect(data.value[0]).to.not.have.property('PersonFullName')
    })
})
