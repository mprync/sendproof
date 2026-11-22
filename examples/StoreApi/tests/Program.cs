// The direct runner exercises the same integration tests where VSTest cannot bind a local socket.
var tests = new StoreFlowTests();
await tests.Authentication_preview_send_validation_and_switch_use_real_sqlite();
await tests.Order_flow_covers_cart_quote_shipment_refund_and_cancel_and_every_write_previews_without_persisting();
await tests.Deprecated_operations_publish_replacements_and_sunset_and_enums_publish_descriptions();
await tests.Seed_data_is_realistic_consistent_and_reconciles();
await tests.OpenApi_document_describes_every_operation_parameter_and_property();
await tests.Persona_switching_is_local_and_same_origin_for_anonymous_callers();
tests.Cookie_keys_live_beside_the_demo_database();
Console.WriteLine("Store integration flows passed.");
