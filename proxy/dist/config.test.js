import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnvConfig } from "./config.js";
describe("loadEnvConfig", () => {
    const ORIGINAL_ENV = process.env;
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });
    afterEach(() => {
        process.env = ORIGINAL_ENV;
    });
    it("returns config when both env vars are set", () => {
        process.env.RELAY_URL = "wss://example.com";
        process.env.RELAY_AUTH_TOKEN = "secret-token";
        const config = loadEnvConfig();
        expect(config).toEqual({
            relayUrl: "wss://example.com",
            relayAuthToken: "secret-token",
        });
    });
    it("throws when RELAY_URL is missing", () => {
        delete process.env.RELAY_URL;
        process.env.RELAY_AUTH_TOKEN = "secret-token";
        expect(() => loadEnvConfig()).toThrowError("Missing required environment variable: RELAY_URL");
    });
    it("throws when RELAY_AUTH_TOKEN is missing", () => {
        process.env.RELAY_URL = "wss://example.com";
        delete process.env.RELAY_AUTH_TOKEN;
        expect(() => loadEnvConfig()).toThrowError("Missing required environment variable: RELAY_AUTH_TOKEN");
    });
    it("throws when both env vars are missing", () => {
        delete process.env.RELAY_URL;
        delete process.env.RELAY_AUTH_TOKEN;
        expect(() => loadEnvConfig()).toThrowError("Missing required environment variable: RELAY_URL");
    });
    it("treats empty string as missing", () => {
        process.env.RELAY_URL = "";
        process.env.RELAY_AUTH_TOKEN = "secret-token";
        expect(() => loadEnvConfig()).toThrowError("Missing required environment variable: RELAY_URL");
    });
});
//# sourceMappingURL=config.test.js.map