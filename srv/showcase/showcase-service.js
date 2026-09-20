const cds = require('@sap/cds')

const LOG = cds.log('showcase')

/**
 * Implementation for FederationShowcaseService.
 *
 * Every entity in showcase-service.cds is served by cds-data-federation's own
 * handlers, so there is nothing to implement for the delegation scenarios. The
 * only code here is the *fourth* replication trigger: a remote domain event.
 */
class FederationShowcaseService extends cds.ApplicationService {

    async init() {
        await this.refresh_replica_on_remote_event()
        return super.init()
    }

    /**
     * Event-driven refresh of the replicated `sap.capire.xflights.Flights`.
     *
     * xflights emits `FlightsUpdated` whenever ReserveSeats or ReleaseSeats
     * changes a flight's seat counts. The schedule alone would not pick that up
     * for another ten minutes, which is long enough for the app to offer a seat
     * that is already gone.
     *
     * Upstream did this with a hand-written read-and-UPDATE in
     * srv/travel-service/service.js, guarded by `@cds.persistence.table` — an
     * annotation its own srv/data-federation.js set on every `@federated`
     * entity, including the service-level projection the guard read. This
     * branch deletes that file, and cds-data-federation deliberately sets the
     * annotation `false` on derived service projections (they stay views over
     * the replica rather than getting a table of their own), so the guard was
     * never true and the handler silently stopped registering.
     *
     * `executeEvent` (ADR 0013) replaces it with a real pipeline run: the row
     * is re-read through the consumption view, so every projected column is
     * refreshed and the static `where` still applies; the write is an upsert,
     * retried on failure, serialized against a concurrent scheduled run, and
     * recorded in PipelineRuns with `trigger: 'event'`.
     *
     * Set `cds.showcase.eventRefresh: false` (package.json) to watch plain
     * replication instead: the replica then lags until the next run.
     */
    async refresh_replica_on_remote_event() {

        const xflights = await cds.connect.to('sap.capire.flights.FlightsService')
        const pipelines = await cds.connect.to('data-pipeline')

        xflights.on('FlightsUpdated', async msg => {
            if (cds.env.showcase?.eventRefresh === false) return
            // The event carries the remote's own key names; `read: 'key'`
            // expects exactly those.
            const { flight: ID, date } = msg.data
            try {
                const { runId, done } = await pipelines.executeEvent('Flights', {
                    event: { read: 'key', keys: { ID, date } },
                })
                await done
                LOG.info('refreshed Flights', { ID, date }, 'run', runId)
            } catch (e) {
                // A failed refresh must not break the flow that emitted the
                // event. The next scheduled run reconciles the row anyway.
                LOG.warn('event-driven refresh of Flights failed:', e.message)
            }
        })
    }
}

module.exports = FederationShowcaseService
