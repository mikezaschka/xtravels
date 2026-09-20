using { sap.capire.flights.FlightsService as external } from '@capire/xflights-data';
namespace sap.capire.xflights;

/**
 * Consumption view declaring the subset of fields we actually want to use
 * from the external Flights entity, with associations like airline, origin,
 * destination flattened (aka denormalized).
 */
@federation.replicate: {
  mode: 'delta', delta: { field: 'modifiedAt' },
  schedule: 600000, // 10 minutes, same cadence as the original srv/data-federation.js
  preload: true,
}
entity Flights as projection on external.Flights {
  ID, date, departure, arrival, free_seats, modifiedAt,
  price, currency,
  airline.icon     as icon @UI.IsImageURL,
  airline.name     as airline,
  origin.name      as origin,
  destination.name as destination,
}

/**
 * Consumption view declaring the subset of fields we actually want to use
 * from the external Supplements entity.
 */
@federation.replicate: {
  mode: 'delta', delta: { field: 'modifiedAt' },
  schedule: 600000,
  preload: true,
}
entity Supplements as projection on external.Supplements {
  ID, type, descr, price, currency, modifiedAt
}
