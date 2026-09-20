const cds = require('@sap/cds')

/**
 * The @capire/s4 sample data is 728 business partners, every one of them a
 * person (`BusinessPartnerCategory = '1'`). A consumption view scoped to
 * companies would therefore be indistinguishable from a broken filter, so this
 * provider adds a handful of organizations to federate against.
 */
const ORGANIZATIONS = [
    { BusinessPartner: '900001', PersonFullName: 'Aurora Logistics GmbH', BusinessPartnerCategory: '2' },
    { BusinessPartner: '900002', PersonFullName: 'Northwind Travel Agency Ltd', BusinessPartnerCategory: '2' },
    { BusinessPartner: '900003', PersonFullName: 'Pacific Charter Airlines Inc', BusinessPartnerCategory: '2' },
    { BusinessPartner: '900004', PersonFullName: 'Meridian Hotels S.A.', BusinessPartnerCategory: '2' },
]

cds.once('served', async () => {
    const E = 'API_BUSINESS_PARTNER.A_BusinessPartner'
    const today = new Date().toISOString().slice(0, 10)
    await UPSERT.into(E).entries(
        ORGANIZATIONS.map(o => ({ ...o, LastChangeDate: today, LastChangeTime: '12:00:00' })),
    )
    cds.log('s4-provider').info(`seeded ${ORGANIZATIONS.length} organizations (BusinessPartnerCategory '2')`)
})

module.exports = cds.server
