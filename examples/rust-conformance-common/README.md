# Rust conformance fixtures: shared parts

Sessions, authorization, the item operations, the OpenAPI document, the scenarios and the database and Sendproof setup that the Axum and Actix fixtures have in common. No web framework appears here. The item operations are generic over the SQLx backend (`Db<B>`); `setup::Database` opens the database `BENCH_DATABASE` names.
