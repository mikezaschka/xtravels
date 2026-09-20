// Import the raw imported-API model, not the @capire/s4 entry point: the latter
// applies @cds.minify, which strips every entity a consuming project does not
// reference — leaving a provider with no entity sets at all.
using from '@capire/s4/srv/external/API_BUSINESS_PARTNER';
