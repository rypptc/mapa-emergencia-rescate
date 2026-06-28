import { describe, it, expect, afterEach, vi } from "vitest";
import { checkRateLimit, clientIp } from "@/lib/ratelimit";

// El contador es estado de módulo: cada prueba usa un identificador único para
// no interferir con las demás.
let n = 0;
const uniqueId = () => `test-ip-${n++}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimit", () => {
  it("permite hasta el límite por defecto (8) y luego bloquea", async () => {
    const id = uniqueId();
    for (let i = 0; i < 8; i++) {
      expect(await checkRateLimit(id)).toBe(true);
    }
    expect(await checkRateLimit(id)).toBe(false);
  });

  it("respeta un límite personalizado", async () => {
    const id = uniqueId();
    expect(await checkRateLimit(id, 2)).toBe(true);
    expect(await checkRateLimit(id, 2)).toBe(true);
    expect(await checkRateLimit(id, 2)).toBe(false);
  });

  it("cuenta por identificador de forma independiente", async () => {
    const a = uniqueId();
    const b = uniqueId();
    expect(await checkRateLimit(a, 1)).toBe(true);
    expect(await checkRateLimit(b, 1)).toBe(true); // otra key, no afectada
    expect(await checkRateLimit(a, 1)).toBe(false);
  });

  it("vuelve a permitir cuando pasa la ventana de tiempo", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const id = uniqueId();

    expect(await checkRateLimit(id, 1)).toBe(true);
    expect(await checkRateLimit(id, 1)).toBe(false);

    vi.setSystemTime(61_000); // > WINDOW_MS (60 s)
    expect(await checkRateLimit(id, 1)).toBe(true);
  });
});

describe("clientIp", () => {
  it("usa x-real-ip cuando está presente", () => {
    const req = new Request("http://test/", {
      headers: { "x-real-ip": "1.2.3.4" },
    });
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("cae a 'anon' cuando no hay cabecera de IP", () => {
    expect(clientIp(new Request("http://test/"))).toBe("anon");
  });

  it("prefiere TRUSTED_IP_HEADER sobre x-real-ip", () => {
    vi.stubEnv("TRUSTED_IP_HEADER", "cf-connecting-ip");
    const req = new Request("http://test/", {
      headers: { "cf-connecting-ip": "9.9.9.9", "x-real-ip": "1.1.1.1" },
    });
    expect(clientIp(req)).toBe("9.9.9.9");
    vi.unstubAllEnvs();
  });

  it("toma el hop MÁS A LA DERECHA de TRUSTED_IP_HEADER (no el cliente)", () => {
    // El valor más a la izquierda lo controla el cliente (un proxy ANTEPONE su
    // hop), así que es falsificable. Tomamos el último: el que añadió el proxy
    // más cercano a la app. Ver el comentario en lib/ratelimit.ts.
    vi.stubEnv("TRUSTED_IP_HEADER", "x-forwarded-for");
    const req = new Request("http://test/", {
      headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8", "x-real-ip": "1.1.1.1" },
    });
    expect(clientIp(req)).toBe("8.8.8.8");
    vi.unstubAllEnvs();
  });
});
