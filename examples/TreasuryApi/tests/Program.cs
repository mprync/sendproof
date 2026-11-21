// The direct runner exercises the same integration tests where VSTest cannot bind a local socket.
var tests = new TreasuryFlowTests();
await tests.Authentication_preview_send_validation_and_switch_use_real_sqlite();
await tests.Approval_flow_enforces_four_eyes_and_every_write_previews_without_persisting();
await tests.Seed_data_is_realistic_checksum_valid_and_reconciles();
await tests.OpenApi_document_describes_every_operation_parameter_and_property();
tests.Cookie_keys_live_beside_the_demo_database();
Console.WriteLine("Treasury integration flows passed.");
