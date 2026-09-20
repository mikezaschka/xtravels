// HotelsService is a "late-cut" microservice: annotated `@agent @mcp` and
// `@cds.external:2`, so the app itself never serves it over HTTP. Federating
// against it as a real remote needs an OData endpoint — added here rather than
// by patching srv/hotels/services.cds.
using { sap.capire.hotels.HotelsService } from '../../../srv/hotels/services';

annotate HotelsService with @odata @rest;
