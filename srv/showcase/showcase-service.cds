using { sap.capire.flights.FlightsService as flights } from '@capire/xflights-data';
using { sap.capire.hotels.HotelsService as hotels } from '../hotels/services';
using { API_BUSINESS_PARTNER as S4 } from '@capire/s4';

namespace sap.capire.travels.showcase;

/**
 * Federation showcase — live delegation variations against the same remotes the
 * app already replicates from: xflights, the bundled HotelsService, and the S/4
 * Business Partner API.
 *
 * Deliberately a service of its own: TravelService and the Fiori app stay
 * exactly as upstream ships them, and everything here is additive. Entities are
 * added one scenario at a time — see examples/xtravels/README.md in the
 * cds-data monorepo for the catalogue and the matching tests.
 */
@path: '/showcase'
service FederationShowcaseService {

    /**
     * Plain delegation: every read is forwarded to xflights at request time,
     * nothing is stored locally. Airlines is reference data that changes
     * rarely and is small, but it must never be stale in a booking UI — the
     * opposite trade-off to the replicated Flights table next door.
     *
     * No write flags, so the plugin enforces @readonly: CUD requests are
     * rejected with 405 rather than silently reaching the remote.
     */
    @federation.delegate
    entity Airlines as projection on flights.Airlines {
        ID,
        name,
        icon @UI.IsImageURL,
        currency,
        // Both sides live on the remote, so $expand is resolved over there in
        // one request — no local join, nothing replicated. The target has to be
        // exposed here too, or CAP drops the navigation property.
        flights : redirected to LiveFlights
    };

    /**
     * ── One remote entity, four strategies ──────────────────────────────────
     *
     * `FlightsService.Flights` is mapped four times: replicated into
     * `sap.capire.xflights.Flights` by the app itself, and delegated three ways
     * here. Same data, same shape — so any difference in behaviour is the
     * strategy and nothing else. The matrix in examples/xtravels/README.md of
     * the cds-data monorepo says which is which, and test/federation-strategies
     * asserts every cell of it.
     *
     * Live: read at request time, no local copy. Seat counts that must not be a
     * minute stale — booking a seat that is already gone is the failure this
     * prevents. Also the expand target for `Airlines`.
     */
    @federation.delegate
    entity LiveFlights as projection on flights.Flights {
        ID,
        date,
        free_seats,
        occupied_seats,
        price,
        currency,
        airline // carries the ON-condition for Airlines:flights
    };

    /**
     * Delegation with a response cache. Airports are the classic value-help
     * list: read on nearly every screen, changed about never. The remote is
     * still the single source of truth, but repeated reads are answered from
     * cds-caching for a minute instead of crossing the network each time.
     *
     * Cache entries are keyed by the query, so a different $filter or $select
     * is a different entry — and every entry carries the automatic
     * `federation:Airports` tag, so the whole entity can be invalidated at once
     * when something upstream changes.
     */
    @federation.delegate: {
        cache: {
            strategy: 'response',
            ttl: 60000,
            tags: [ 'airports' ]
        }
    }
    entity Airports as projection on flights.Airports {
        ID,
        name,
        city,
        country
    };

    /**
     * Snapshot: a local SQLite copy of the remote entity, refilled when the TTL
     * expires. Arbitrary CQN runs as SQL against the snapshot, so filtering,
     * sorting and aggregating cost nothing remotely and keep working while the
     * remote is unreachable — at the price of being up to a TTL stale.
     *
     * Unlike replication this is a cache, not a table you own: it is not
     * joinable from other entities and it is dropped and refilled wholesale.
     */
    @federation.delegate: {
        cache: {
            strategy: 'entity',
            ttl: 30000,
            preload: true
        }
    }
    entity SnapshotFlights as projection on flights.Flights {
        ID,
        date,
        free_seats,
        occupied_seats,
        price,
        currency,
        airline
    };

    /**
     * Response cache: whole responses kept per query. A repeated *identical*
     * query is free; a different `$filter` is a different entry and goes to the
     * remote. The lightest option, and the one that helps least when clients
     * query in many different shapes.
     */
    @federation.delegate: {
        cache: {
            strategy: 'response',
            ttl: 60000
        }
    }
    entity CachedFlights as projection on flights.Flights {
        ID,
        date,
        free_seats,
        occupied_seats,
        price,
        currency,
        airline
    };

    /**
     * Read-only delegate to the hotel catalogue, and the target `HotelBookings`
     * navigates to. Same annotation as `Airlines`: no write flags, so the
     * plugin enforces @readonly and CUD is rejected with 405.
     */
    @federation.delegate
    entity Hotels as projection on hotels.Hotels {
        ID,
        name,
        city,
        country,
        stars,
        pricePerNight,
        availableRooms
    };

    /**
     * Write-through: the one entity here that accepts CUD. A booking created
     * against this service is forwarded to the hotels microservice
     * synchronously, and lives only there — nothing is stored locally, and the
     * caller gets the remote's answer (or its error).
     *
     * `writable: true` is shorthand for create + update + delete; the three can
     * be opted into individually. Writes are deliberately *not* outboxed: the
     * client is waiting for the outcome, so a queue would break the contract.
     */
    @federation.delegate: { writable: true }
    entity HotelBookings as projection on hotels.Bookings {
        ID,
        hotel : redirected to Hotels,
        guest,
        checkIn,
        checkOut,
        rooms,
        status,
        totalPrice
    };

    /**
     * The S/4 Business Partner API, delegated and scoped to companies — the
     * mirror image of the app's replicated `Customers`, which scopes the same
     * remote entity to persons and syncs it into a local table.
     *
     * Three things at once: renames (`BusinessPartner as ID`), a static `where`
     * written with CDL's null-safe `==`, and a remote that is OData V2 in
     * xtravels' own [production] profile. The `where` is applied by the plugin
     * on every request — CAP does not support `where` on projections over
     * remote services at all.
     */
    @federation.delegate
    entity Organizations as projection on S4.A_BusinessPartner {
        BusinessPartner as ID,
        PersonFullName  as name,
        LastChangeDate  as modifiedAt
    } where BusinessPartnerCategory == '2';
}
