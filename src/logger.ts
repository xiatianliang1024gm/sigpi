import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { LoggingConfig } from "./config.js";
import { formatLocalTimestamp } from "./time.js";
import type { JsonValue, LogLevel, RuntimeLogger } from "./types.js";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};
const SENSITIVE_FIELD_PATTERN =
	/(?:api[_-]?key|authorization|bearer|password|passwd|secret|token|credential)/iu;
const REDACTED_VALUE = "[REDACTED]";

export class StructuredLogger implements RuntimeLogger {
	constructor(
		private readonly options: {
			level: LogLevel;
			filePath: string;
			consoleEnabled: boolean;
			now?: () => Date;
			maxBodyPreviewChars?: number;
			maxConsoleBodyPreviewChars?: number;
		},
	) {
		const dir = path.dirname(options.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.maxBodyPreviewChars = options.maxBodyPreviewChars ?? 16_000;
		this.maxConsoleBodyPreviewChars = options.maxConsoleBodyPreviewChars ?? 500;
	}

	private readonly maxBodyPreviewChars: number;
	private readonly maxConsoleBodyPreviewChars: number;

	debug(event: string, fields?: Record<string, JsonValue | undefined>): void {
		this.write("debug", event, fields);
	}

	info(event: string, fields?: Record<string, JsonValue | undefined>): void {
		this.write("info", event, fields);
	}

	warn(event: string, fields?: Record<string, JsonValue | undefined>): void {
		this.write("warn", event, fields);
	}

	error(event: string, fields?: Record<string, JsonValue | undefined>): void {
		this.write("error", event, fields);
	}

	private write(
		level: LogLevel,
		event: string,
		fields?: Record<string, JsonValue | undefined>,
	): void {
		if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.options.level]) {
			return;
		}

		const currentTime = this.options.now?.() ?? new Date();
		const sanitized = sanitizeFields(fields);
		const fileFields = capBodyPreview(sanitized, this.maxBodyPreviewChars);
		const record = JSON.stringify({
			ts: formatLocalTimestamp(currentTime),
			level,
			event,
			...(fileFields ?? {}),
		});

		appendFileSync(
			resolveDatedLogFilePath(this.options.filePath, currentTime),
			`${record}\n`,
			"utf8",
		);

		if (this.options.consoleEnabled) {
			const consoleFields = capBodyPreview(
				sanitized,
				this.maxConsoleBodyPreviewChars,
			);
			const line = `[${level}] ${event}${consoleFields ? ` ${JSON.stringify(consoleFields)}` : ""}`;
			if (level === "warn" || level === "error") {
				console.error(line);
			} else {
				console.log(line);
			}
		}
	}
}

export function createLogger(config: LoggingConfig): RuntimeLogger {
	const level = normalizeLevel(config.level);
	const filePath = path.resolve(process.cwd(), config.filePath);
	const consoleEnabled = config.toConsole;
	const maxBodyPreviewChars = config.maxBodyPreviewChars ?? 16_000;
	const maxConsoleBodyPreviewChars = config.maxConsoleBodyPreviewChars ?? 500;

	return new StructuredLogger({
		level,
		filePath,
		consoleEnabled,
		maxBodyPreviewChars,
		maxConsoleBodyPreviewChars,
	});
}

export function resolveDatedLogFilePath(
	filePath: string,
	date: Date = new Date(),
): string {
	const parsed = path.parse(filePath);
	const suffix = formatDateSuffix(date);
	const fileName = parsed.ext
		? `${parsed.name}.${suffix}${parsed.ext}`
		: `${parsed.base}.${suffix}`;

	return path.join(parsed.dir, fileName);
}

export function createChildLogger(
	logger: RuntimeLogger,
	defaultFields: Record<string, JsonValue | undefined>,
): RuntimeLogger {
	return {
		debug: (event, fields) => {
			logger.debug(event, mergeFields(defaultFields, fields));
		},
		info: (event, fields) => {
			logger.info(event, mergeFields(defaultFields, fields));
		},
		warn: (event, fields) => {
			logger.warn(event, mergeFields(defaultFields, fields));
		},
		error: (event, fields) => {
			logger.error(event, mergeFields(defaultFields, fields));
		},
	};
}

function normalizeLevel(rawLevel: string | undefined): LogLevel {
	switch (rawLevel) {
		case "debug":
		case "info":
		case "warn":
		case "error":
			return rawLevel;
		default:
			return "info";
	}
}

function sanitizeFields(
	fields: Record<string, JsonValue | undefined> | undefined,
): Record<string, JsonValue> | undefined {
	if (!fields) {
		return undefined;
	}

	const result: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) {
			result[key] = sanitizeValue(key, value);
		}
	}
	return result;
}

function sanitizeValue(key: string, value: JsonValue): JsonValue {
	if (SENSITIVE_FIELD_PATTERN.test(key)) {
		return REDACTED_VALUE;
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(key, item));
	}

	if (value && typeof value === "object") {
		const result: Record<string, JsonValue> = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			result[childKey] = sanitizeValue(childKey, childValue);
		}
		return result;
	}

	if (typeof value === "string") {
		return redactInlineSecrets(value);
	}

	return value;
}

function redactInlineSecrets(value: string): string {
	return value
		.replace(
			/(authorization\s*:\s*bearer\s+)[^\s"',}]+/giu,
			`$1${REDACTED_VALUE}`,
		)
		.replace(
			/((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s"',}]+/giu,
			`$1${REDACTED_VALUE}`,
		);
}

function mergeFields(
	defaultFields: Record<string, JsonValue | undefined>,
	overrideFields: Record<string, JsonValue | undefined> | undefined,
): Record<string, JsonValue | undefined> {
	return {
		...defaultFields,
		...overrideFields,
	};
}

function capBodyPreview(
	fields: Record<string, JsonValue> | undefined,
	maxChars: number,
): Record<string, JsonValue> | undefined {
	if (!fields || typeof fields.bodyPreview !== "string") {
		return fields;
	}

	const value = fields.bodyPreview;
	if (value.length <= maxChars) {
		return fields;
	}

	return {
		...fields,
		bodyPreview: `${value.slice(0, maxChars)}\n...[truncated]`,
	};
}

function formatDateSuffix(date: Date): string {
	const year = date.getFullYear().toString().padStart(4, "0");
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate().toString().padStart(2, "0");

	return `${year}-${month}-${day}`;
}
