// Generator input only; native modules use the generated, import-free block. One static assignment per class, not a loop:
// Porffor resolves a bare `ReadableStream` at compile time from visible globalThis.X assignments, and a dynamic install
// compiled `new ReadableStream()` to a ReferenceError where the prelude is a separate unit (sproutd). gen-streams.ts checks the list.
import * as streams from "web-streams-polyfill";
if (globalThis.ByteLengthQueuingStrategy == null) globalThis.ByteLengthQueuingStrategy = streams.ByteLengthQueuingStrategy;
if (globalThis.CountQueuingStrategy == null) globalThis.CountQueuingStrategy = streams.CountQueuingStrategy;
if (globalThis.ReadableByteStreamController == null) globalThis.ReadableByteStreamController = streams.ReadableByteStreamController;
if (globalThis.ReadableStream == null) globalThis.ReadableStream = streams.ReadableStream;
if (globalThis.ReadableStreamBYOBReader == null) globalThis.ReadableStreamBYOBReader = streams.ReadableStreamBYOBReader;
if (globalThis.ReadableStreamBYOBRequest == null) globalThis.ReadableStreamBYOBRequest = streams.ReadableStreamBYOBRequest;
if (globalThis.ReadableStreamDefaultController == null) globalThis.ReadableStreamDefaultController = streams.ReadableStreamDefaultController;
if (globalThis.ReadableStreamDefaultReader == null) globalThis.ReadableStreamDefaultReader = streams.ReadableStreamDefaultReader;
if (globalThis.TransformStream == null) globalThis.TransformStream = streams.TransformStream;
if (globalThis.TransformStreamDefaultController == null) globalThis.TransformStreamDefaultController = streams.TransformStreamDefaultController;
if (globalThis.WritableStream == null) globalThis.WritableStream = streams.WritableStream;
if (globalThis.WritableStreamDefaultController == null) globalThis.WritableStreamDefaultController = streams.WritableStreamDefaultController;
if (globalThis.WritableStreamDefaultWriter == null) globalThis.WritableStreamDefaultWriter = streams.WritableStreamDefaultWriter;
