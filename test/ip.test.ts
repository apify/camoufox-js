import { describe, expect, test } from "vitest";
import {
	InvalidIP,
	InvalidProxy,
	ProxyHelper,
	validIPv4,
	validIPv6,
	validateIP,
} from "../src/ip";

describe("validIPv4", () => {
	test("accepts valid IPv4 addresses", () => {
		expect(validIPv4("192.168.1.1")).toBe(true);
		expect(validIPv4("0.0.0.0")).toBe(true);
		expect(validIPv4("255.255.255.255")).toBe(true);
		expect(validIPv4("8.8.8.8")).toBe(true);
		expect(validIPv4("10.0.0.1")).toBe(true);
	});

	test("rejects invalid IPv4 addresses", () => {
		expect(validIPv4("")).toBe(false);
		expect(validIPv4(false)).toBe(false);
		expect(validIPv4("not-an-ip")).toBe(false);
		expect(validIPv4("256.1.1.1")).toBe(true); // regex doesn't check range, matches Python
		expect(validIPv4("1.2.3")).toBe(false);
		expect(validIPv4("1.2.3.4.5")).toBe(false);
		expect(validIPv4("::1")).toBe(false);
	});
});

describe("validIPv6", () => {
	test("accepts valid IPv6 addresses", () => {
		expect(validIPv6("::1")).toBe(true);
		expect(validIPv6("fe80::1")).toBe(true);
		expect(validIPv6("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(true);
		expect(validIPv6("::")).toBe(true);
	});

	test("rejects invalid IPv6 addresses", () => {
		expect(validIPv6("")).toBe(false);
		expect(validIPv6(false)).toBe(false);
		expect(validIPv6("192.168.1.1")).toBe(false);
		expect(validIPv6("not-an-ip")).toBe(false);
	});
});

describe("validateIP", () => {
	test("accepts valid IPv4", () => {
		expect(() => validateIP("8.8.8.8")).not.toThrow();
	});

	test("accepts valid IPv6", () => {
		expect(() => validateIP("::1")).not.toThrow();
	});

	test("throws InvalidIP for invalid addresses", () => {
		expect(() => validateIP("not-an-ip")).toThrow(InvalidIP);
		expect(() => validateIP("")).toThrow(InvalidIP);
	});
});

describe("ProxyHelper", () => {
	describe("parseServer", () => {
		test("parses full proxy URL with schema and port", () => {
			const result = ProxyHelper.parseServer("http://proxy.example.com:8080");
			expect(result.schema).toBe("http");
			expect(result.url).toBe("proxy.example.com");
			expect(result.port).toBe("8080");
		});

		test("parses socks5 proxy", () => {
			const result = ProxyHelper.parseServer("socks5://127.0.0.1:1080");
			expect(result.schema).toBe("socks5");
			expect(result.url).toBe("127.0.0.1");
			expect(result.port).toBe("1080");
		});

		test("defaults schema to http when not provided", () => {
			const result = ProxyHelper.parseServer("proxy.example.com:8080");
			expect(result.schema).toBe("http");
			expect(result.url).toBe("proxy.example.com");
			expect(result.port).toBe("8080");
		});

		test("parses proxy without port", () => {
			const result = ProxyHelper.parseServer("http://proxy.example.com");
			expect(result.schema).toBe("http");
			expect(result.url).toBe("proxy.example.com");
			expect(result.port).toBeUndefined();
		});
	});

	describe("asString", () => {
		test("builds full proxy string with auth", () => {
			const result = ProxyHelper.asString({
				server: "http://proxy.example.com:8080",
				username: "user",
				password: "pass",
			});
			expect(result).toBe("http://user:pass@proxy.example.com:8080");
		});

		test("builds proxy string without auth", () => {
			const result = ProxyHelper.asString({
				server: "http://proxy.example.com:8080",
			});
			expect(result).toBe("http://proxy.example.com:8080");
		});

		test("builds proxy string with username only", () => {
			const result = ProxyHelper.asString({
				server: "http://proxy.example.com:8080",
				username: "user",
			});
			expect(result).toBe("http://user@proxy.example.com:8080");
		});

		test("defaults schema to http", () => {
			const result = ProxyHelper.asString({
				server: "proxy.example.com:3128",
			});
			expect(result).toBe("http://proxy.example.com:3128");
		});
	});

	describe("asAxiosProxy", () => {
		test("returns http and https keys", () => {
			const result = ProxyHelper.asAxiosProxy("http://proxy.example.com:8080");
			expect(result).toEqual({
				http: "http://proxy.example.com:8080",
				https: "http://proxy.example.com:8080",
			});
		});
	});
});
