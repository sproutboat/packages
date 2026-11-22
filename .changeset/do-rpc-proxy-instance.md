---
"@sproutboat/runtime": patch
---

Durable Object RPC reaches the names an instance answers itself. A class whose constructor returns a Proxy (Alchemy's Durable Object bridge answers every unknown method name through its get trap) used to fail every stub call with "The RPC receiver does not implement the method": the lookup only read the class's prototype chain. It now falls back to the instance when the class does not define the name, still refusing `constructor`, the names every object has and own data properties. `WebSocketPair` is iterable (`const [client, server] = new WebSocketPair()`, as in workerd; it was only an object with keys `0` and `1`). Both only turn a failure into a result, so there is no compatibility date.
