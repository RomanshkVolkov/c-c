import { describe, expect, it } from "vitest";

import { recordingFromMetadata } from "./recording-metadata";

// Los mismos casos que `recording_tests` en `voice.rs`, uno a uno: los dos
// motores tienen que leer el metadata igual, o un invitado vería REC donde un
// miembro no.
describe("recordingFromMetadata", () => {
  it("sin grabación no hay señal", () => {
    for (const crudo of ["", "{}", "no soy json", "null", "[]", '{"otra":"cosa"}', undefined, null]) {
      expect(recordingFromMetadata(crudo), String(crudo)).toBeNull();
    }
  });

  it("una grabación nula es no grabar", () => {
    expect(recordingFromMetadata('{"recording":null}')).toBeNull();
  });

  it("a medias no cuenta", () => {
    for (const crudo of [
      '{"recording":{}}',
      '{"recording":{"id":"rec-1"}}',
      '{"recording":{"by":"u-ana"}}',
      '{"recording":{"id":"","by":"u-ana"}}',
      '{"recording":{"id":"rec-1","by":""}}',
      '{"recording":{"id":1,"by":"u-ana"}}',
    ]) {
      expect(recordingFromMetadata(crudo), crudo).toBeNull();
    }
  });

  it("con id y dueño, sí", () => {
    expect(
      recordingFromMetadata('{"recording":{"id":"rec-1","by":"u-ana","since":"2026-09-18T00:00:00Z"}}'),
    ).toEqual({ id: "rec-1", by: "u-ana", since: "2026-09-18T00:00:00Z" });
  });

  it("sin since el chip sigue encendido", () => {
    expect(recordingFromMetadata('{"recording":{"id":"rec-1","by":"u-ana"}}')).toEqual({
      id: "rec-1",
      by: "u-ana",
      since: "",
    });
  });

  it("convive con otras claves", () => {
    expect(recordingFromMetadata('{"algo":"otro","recording":{"id":"rec-1","by":"u-ana"},"mas":1}')).not.toBeNull();
  });
});
