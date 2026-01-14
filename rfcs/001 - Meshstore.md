# RFC 001: Meshstore – Datastore for Backmesh

## Overview
Meshstore is a runtime-agnostic Rust library designed to offer a robust, flexible datastore API with offline support, automatic replication capabilities, realtime updates, and implicit access control. It enables seamless usage across different runtime environments and clients, leveraging backend key-value (KV) stores starting with Cloudflare KV and LMDB.

## Goals

- Runtime agnostic with bindings for Dart, Swift, Java, and React Native.
- Allow for clients to listen to realtime updates via SSE.
- Allow flexible backing with pluggable KV storage implementations.
- Simple yet effective access control model without complex generalized RLS or security rules.
- Support data replication across multiple instances locally and remotely
- Provide an offline-first datastore experience.

## Architecture

### Core Components

#### Datastore Interface
A standard Rust trait defining the core API required by underlying KV backends:
- `get(key)`
- `set(key, value)`
- `delete(key)`
- `list(prefix)`

#### KV Backend Implementations
- **Cloudflare KV** (Cloud-native, distributed KV store)
- **LMDB** (Embedded KV store for offline/local storage)

### Data Model and Access Patterns

The datastore supports collections and follows a structured path model to manage access control implicitly via namespaces:

```
/${uid}/private/*          # Read+Write access only for user with uid {uid}
/${uid}/public/*           # Write access for user with uid {uid}, read access for anyone without authentication
/${uid}/internal/*         # Write access for user with uid {uid}, read access for any authenticated user

/internal/*               # Read+Write access for any authenticated user
/public/*                 # Write access for any authenticated user, read access for anyone without authentication
```

This simple structure clearly spells out the most common user permissions without complex RLS or security rules. 

### Offline and Replication Strategy
- Data stored on devices using LMDB.
- Real-time synchronization via Server-Sent Events (SSE) and Rust-based replicator.
- The replicator and SSE are KV-focused unaware of the structured collections built on top of it.

## Bindings and Runtime Support
- **Dart (Flutter)**
- **Swift (iOS/macOS)**
- **Java (Android)**
- **React Native (JS bridge)**

These bindings will provide native-feeling SDKs leveraging the core Rust datastore functionality, e.g. Streams in Dart and Java, Events in React Native.

## Implementation Phases

### Phase 1: Datastore API and Cloudflare KV
- Rust library wrapping a KV that runs on any Rust runtime with defined collections and access controls as outlined above.
- Implement Cloudflare KV as first KV backend for the Datastore API.
- Expose Datastore API backed with Cloudflare KV on a Rust Cloudflare worker.

### Phase 2: Runtime Bindings and realtime updates
- Expose Datastore API to Flutter, Swift, Java, and React Native environments.
- Allow for clients to receive realtime updates via SSE.

### Phase 3: Offline and LMDB
- LMDB backend for Datastore API for offline/local storage.
- Implement Rust-based replicator for local-to-remote KV synchronization
- Offline sync resources:https://gist.github.com/pesterhazy/3e039677f2e314cb77ffe3497ebca07b

### Phase 4: Vector Support (Future Work)
- Extend datastore capabilities to efficiently handle vector embeddings.

## Considerations and Alternatives

### Simplicity vs. DX
The simplified access control structure places some important assumptions on how the user's app works. However, it significantly improves maintainability, security and ease of implementation. This trade-off and the implicit data model will be continuously reviewed based on user feedback.

## Conclusion
Meshstore offers an effective, streamlined offline-first datastore API and replication mechanism suitable for modern applications. Its incremental, phased approach balances rapid initial development with real-world use and feedback.