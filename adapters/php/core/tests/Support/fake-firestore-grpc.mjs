// A stand-in Firestore gRPC server for FirestoreGrpcChannelTest: it answers every v1 Firestore method
// with empty messages and appends each call's method to a log file the moment the call opens, before
// it reads any message, so a call the guard refused never appears. It speaks raw bytes and needs no
// protos. Usage: node fake-firestore-grpc.mjs <path to @grpc/grpc-js> <log file>
// Prints the port it listens on, then serves until it is killed.
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';

const [grpcPath, log] = process.argv.slice(2);
const grpc = createRequire(import.meta.url)(grpcPath);

const raw = { requestSerialize: (b) => b, requestDeserialize: (b) => b, responseSerialize: (b) => b, responseDeserialize: (b) => b };
const unary = ['GetDocument', 'ListDocuments', 'CreateDocument', 'UpdateDocument', 'DeleteDocument', 'BeginTransaction', 'Commit', 'Rollback', 'PartitionQuery', 'ListCollectionIds', 'BatchWrite'];
const serverStream = ['BatchGetDocuments', 'RunQuery', 'RunAggregationQuery'];
const bidi = ['Write', 'Listen'];

const service = {};
const handlers = {};
const record = (name) => appendFileSync(log, `google.firestore.v1.Firestore/${name}\n`);
for (const name of unary) {
  service[name] = { path: `/google.firestore.v1.Firestore/${name}`, requestStream: false, responseStream: false, ...raw };
  handlers[name] = (call, callback) => {
    record(name);
    callback(null, Buffer.alloc(0));
  };
}
for (const name of serverStream) {
  service[name] = { path: `/google.firestore.v1.Firestore/${name}`, requestStream: false, responseStream: true, ...raw };
  handlers[name] = (call) => {
    record(name);
    call.end();
  };
}
for (const name of bidi) {
  service[name] = { path: `/google.firestore.v1.Firestore/${name}`, requestStream: true, responseStream: true, ...raw };
  handlers[name] = (call) => {
    record(name);
    call.on('data', () => record(`${name}#message`));
    call.on('end', () => call.end());
  };
}

const server = new grpc.Server();
server.addService(service, handlers);
server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(port);
});
