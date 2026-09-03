import {
  getCompletedOrdersByDateRange,
  type CompletedOrderSummary,
} from "./xcelerator";
import { chatCompletion, isOpenAIConfigured, type ToolDefinition } from "./openai";

export class OrderQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderQueryError";
  }
}

export type CompletedOrdersQueryResult = {
  kind: "completed_orders";
  question: string;
  range: {
    startDate: string;
    endDate: string;
    label: string;
  };
  orders: CompletedOrderSummary[];
  answer: string;
};

type ParsedPeriod = {
  start: Date;
  end: Date;
  label: string;
};

type ParsedDateToken = {
  date: Date;
  year: number;
  monthIndex: number;
  hasYear: boolean;
};

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function periodLabel(start: Date, end: Date): string {
  if (isoDay(start) === isoDay(end)) return formatDate(start);
  return `${formatDate(start)} through ${formatDate(end)}`;
}

function parseIsoDay(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const monthIndex = Number.parseInt(match[2], 10) - 1;
  const day = Number.parseInt(match[3], 10);
  return localDate(year, monthIndex, day);
}

function normalizeQuestion(question: string): string {
  return question
    .replace(/[?!.]+$/g, "")
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function expandYear(rawYear: string | undefined, now: Date): { year: number; hasYear: boolean } {
  if (!rawYear) return { year: now.getFullYear(), hasYear: false };

  const parsed = Number.parseInt(rawYear, 10);
  if (!Number.isFinite(parsed)) return { year: now.getFullYear(), hasYear: false };

  if (parsed < 100) return { year: 2000 + parsed, hasYear: true };
  return { year: parsed, hasYear: true };
}

function localDate(year: number, monthIndex: number, day: number): Date | null {
  const date = new Date(year, monthIndex, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function parseDateToken(
  raw: string,
  now: Date,
  carry?: Pick<ParsedDateToken, "year" | "monthIndex">,
): ParsedDateToken | null {
  const value = normalizeQuestion(raw).replace(/,/g, " ");

  const iso = value.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const year = Number.parseInt(iso[1], 10);
    const monthIndex = Number.parseInt(iso[2], 10) - 1;
    const day = Number.parseInt(iso[3], 10);
    const date = localDate(year, monthIndex, day);
    return date ? { date, year, monthIndex, hasYear: true } : null;
  }

  const slash = value.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
  if (slash) {
    const monthIndex = Number.parseInt(slash[1], 10) - 1;
    const day = Number.parseInt(slash[2], 10);
    const { year, hasYear } = expandYear(slash[3], now);
    const date = localDate(year, monthIndex, day);
    return date ? { date, year, monthIndex, hasYear } : null;
  }

  const monthFirst = value.match(
    new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:\\s+(\\d{2,4}))?\\b`, "i"),
  );
  if (monthFirst) {
    const monthIndex = MONTHS[monthFirst[1].toLowerCase()];
    const day = Number.parseInt(monthFirst[2], 10);
    const { year, hasYear } = expandYear(monthFirst[3], now);
    const date = localDate(year, monthIndex, day);
    return date ? { date, year, monthIndex, hasYear } : null;
  }

  const dayFirst = value.match(
    new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})\\.?(?:\\s+(\\d{2,4}))?\\b`, "i"),
  );
  if (dayFirst) {
    const day = Number.parseInt(dayFirst[1], 10);
    const monthIndex = MONTHS[dayFirst[2].toLowerCase()];
    const { year, hasYear } = expandYear(dayFirst[3], now);
    const date = localDate(year, monthIndex, day);
    return date ? { date, year, monthIndex, hasYear } : null;
  }

  if (carry) {
    const dayOnly = value.match(/^\s*(\d{1,2})\b/);
    if (dayOnly) {
      const day = Number.parseInt(dayOnly[1], 10);
      const date = localDate(carry.year, carry.monthIndex, day);
      return date
        ? { date, year: carry.year, monthIndex: carry.monthIndex, hasYear: false }
        : null;
    }
  }

  return null;
}

function makePeriod(startDate: Date, endDate: Date): ParsedPeriod {
  let start = startOfDay(startDate);
  let end = endOfDay(endDate);

  if (end.getTime() < start.getTime()) {
    [start, end] = [startOfDay(endDate), endOfDay(startDate)];
  }

  return {
    start,
    end,
    label: periodLabel(start, end),
  };
}

function parseRelativePeriod(question: string, now: Date): ParsedPeriod | null {
  const text = question.toLowerCase();

  const lastDays = text.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/);
  if (lastDays) {
    const days = Math.max(1, Math.min(Number.parseInt(lastDays[1], 10), 366));
    return makePeriod(addDays(now, -(days - 1)), now);
  }

  const lastWeeks = text.match(/\b(?:last|past)\s+(\d{1,2})\s+weeks?\b/);
  if (lastWeeks) {
    const weeks = Math.max(1, Math.min(Number.parseInt(lastWeeks[1], 10), 52));
    return makePeriod(addDays(now, -(weeks * 7 - 1)), now);
  }

  const pastMonths = text.match(/\bpast\s+(\d{1,2})\s+months?\b/);
  if (pastMonths) {
    const months = Math.max(1, Math.min(Number.parseInt(pastMonths[1], 10), 24));
    const start = new Date(now);
    start.setMonth(start.getMonth() - months);
    return makePeriod(start, now);
  }

  if (/\byesterday\b/.test(text)) {
    const yesterday = addDays(now, -1);
    return makePeriod(yesterday, yesterday);
  }

  if (/\btoday\b/.test(text)) {
    return makePeriod(now, now);
  }

  if (/\blast\s+week\b/.test(text)) {
    const thisWeekStart = startOfDay(addDays(now, -now.getDay()));
    return makePeriod(addDays(thisWeekStart, -7), addDays(thisWeekStart, -1));
  }

  if (/\bthis\s+week\b/.test(text)) {
    return makePeriod(addDays(now, -now.getDay()), now);
  }

  if (/\blast\s+month\b/.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return makePeriod(start, end);
  }

  if (/\bthis\s+month\b/.test(text)) {
    return makePeriod(new Date(now.getFullYear(), now.getMonth(), 1), now);
  }

  return null;
}

function parseWeekPeriod(question: string, now: Date): ParsedPeriod | null {
  const week = question.match(
    new RegExp(`\\bweek\\s+(?:of|starting|beginning)\\s+(.+?)(?:$|\\s+(?:for|please)\\b)`, "i"),
  );
  if (!week) return null;

  const parsed = parseDateToken(week[1], now);
  if (!parsed) return null;

  return makePeriod(parsed.date, addDays(parsed.date, 6));
}

function parseMonthPeriod(question: string, now: Date): ParsedPeriod | null {
  const monthOnly = question.match(
    new RegExp(
      `\\b(?:in|during|for)?\\s*(?:the\\s+month\\s+of\\s+)?(${MONTH_PATTERN})\\b(?!\\.?\\s+\\d)(?:\\s+(\\d{2,4}))?`,
      "i",
    ),
  );
  if (!monthOnly) return null;

  const monthIndex = MONTHS[monthOnly[1].toLowerCase()];
  const { year } = expandYear(monthOnly[2], now);
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  return makePeriod(start, end);
}

function parseCompactRange(question: string, now: Date): ParsedPeriod | null {
  const monthDayRange = question.match(
    new RegExp(
      `\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})\\s*(?:-|to|through|thru|and)\\s*(\\d{1,2})(?:\\s*,?\\s*(\\d{2,4}))?\\b`,
      "i",
    ),
  );
  if (monthDayRange) {
    const monthIndex = MONTHS[monthDayRange[1].toLowerCase()];
    const { year } = expandYear(monthDayRange[4], now);
    const start = localDate(year, monthIndex, Number.parseInt(monthDayRange[2], 10));
    const end = localDate(year, monthIndex, Number.parseInt(monthDayRange[3], 10));
    if (start && end) return makePeriod(start, end);
  }

  const numericDayRange = question.match(
    /\b(\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?)\s*(?:-|to|through|thru|and)\s*(\d{1,2})\b/i,
  );
  if (numericDayRange) {
    const start = parseDateToken(numericDayRange[1], now);
    if (!start) return null;

    const end = parseDateToken(numericDayRange[2], now, start);
    if (!end) return null;

    return makePeriod(start.date, end.date);
  }

  return null;
}

function parseOpenEndedPeriod(question: string, now: Date): ParsedPeriod | null {
  const since = question.match(/\b(?:since|after)\s+(.+?)(?:$|\s+(?:for|please)\b)/i);
  if (since) {
    const parsed = parseDateToken(since[1], now);
    if (parsed) return makePeriod(parsed.date, now);
  }

  return null;
}

function parseExplicitPeriod(question: string, now: Date): ParsedPeriod | null {
  const text = normalizeQuestion(question);
  const compactRange = parseCompactRange(text, now);
  if (compactRange) return compactRange;

  const weekPeriod = parseWeekPeriod(text, now);
  if (weekPeriod) return weekPeriod;

  const range = text.match(
    /\b(?:between|from)\s+(.+?)\s+(?:and|to|through|thru)\s+(.+?)(?:$|\s+(?:for|please)\b)/i,
  );

  if (range) {
    const start = parseDateToken(range[1], now);
    if (!start) return null;

    const end = parseDateToken(range[2], now, start);
    if (!end) return null;

    if (!end.hasYear && end.date.getTime() < start.date.getTime()) {
      end.date.setFullYear(start.year + 1);
    }

    return makePeriod(start.date, end.date);
  }

  const openEndedPeriod = parseOpenEndedPeriod(text, now);
  if (openEndedPeriod) return openEndedPeriod;

  const onDate = text.match(/\bon\s+(.+?)(?:$|\s+(?:for|please)\b)/i);
  if (onDate) {
    const parsed = parseDateToken(onDate[1], now);
    if (parsed) return makePeriod(parsed.date, parsed.date);
  }

  const dateTokens = Array.from(
    text.matchAll(
      new RegExp(
        `\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b|\\b\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?\\b|\\b(?:${MONTH_PATTERN})\\.?\\s+\\d{1,2}(?:\\s*,?\\s*\\d{2,4})?\\b`,
        "gi",
      ),
    ),
  ).map((match) => match[0]);

  if (dateTokens.length >= 2) {
    const start = parseDateToken(dateTokens[0], now);
    if (!start) return null;
    const end = parseDateToken(dateTokens[1], now, start);
    if (!end) return null;
    return makePeriod(start.date, end.date);
  }

  if (dateTokens.length === 1) {
    const parsed = parseDateToken(dateTokens[0], now);
    if (parsed) return makePeriod(parsed.date, parsed.date);
  }

  return parseMonthPeriod(text, now);
}

export function parseCompletedOrdersQuestion(
  question: string,
  now: Date = new Date(),
): ParsedPeriod | null {
  const normalized = normalizeQuestion(question);
  if (!normalized) return null;

  return parseRelativePeriod(normalized, now) ?? parseExplicitPeriod(normalized, now);
}

function buildAnswer(orders: CompletedOrderSummary[], period: ParsedPeriod): string {
  if (orders.length === 0) {
    return `No delivered orders were found from ${period.label}.`;
  }

  const visible = orders
    .slice(0, 5)
    .map((order) => `${order.referenceNumber} (${formatDateTime(order.completedAt)})`)
    .join(", ");
  const hiddenCount = orders.length > 5 ? `, plus ${orders.length - 5} more` : "";
  const noun = orders.length === 1 ? "order" : "orders";

  return `Found ${orders.length} delivered ${noun} from ${period.label}: ${visible}${hiddenCount}.`;
}

const EXTRACT_PERIOD_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "set_completed_order_period",
    description:
      "Extract the inclusive date period from a question about completed, delivered, done, finished, or closed orders.",
    parameters: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD, or empty when missing.",
        },
        endDate: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD, or empty when missing.",
        },
        needsClarification: {
          type: "boolean",
          description: "True when the user did not provide enough date-period information.",
        },
      },
      required: ["startDate", "endDate", "needsClarification"],
      additionalProperties: false,
    },
  },
};

async function parsePeriodWithModel(
  question: string,
  now: Date,
): Promise<ParsedPeriod | null> {
  if (!isOpenAIConfigured()) return null;

  try {
    const today = isoDay(now);
    const completion = await chatCompletion({
      messages: [
        {
          role: "system",
          content:
            "Extract only the date period for a freight order query. " +
            `Today is ${today}. Interpret relative dates from that date. ` +
            "Default omitted years to today's year. Dates must be inclusive. " +
            "Use needsClarification when no date period is provided.",
        },
        { role: "user", content: question },
      ],
      tools: [EXTRACT_PERIOD_TOOL],
      toolChoice: {
        type: "function",
        function: { name: EXTRACT_PERIOD_TOOL.function.name },
      },
      maxTokens: 80,
      temperature: 0,
    });

    const toolCall = completion.choices[0]?.message.tool_calls?.[0];
    if (!toolCall) return null;

    const args = JSON.parse(toolCall.function.arguments) as {
      startDate?: string;
      endDate?: string;
      needsClarification?: boolean;
    };
    if (args.needsClarification) return null;

    const start = parseIsoDay(args.startDate ?? "");
    const end = parseIsoDay(args.endDate ?? "");
    if (!start || !end) return null;

    return makePeriod(start, end);
  } catch {
    return null;
  }
}

async function resolveCompletedOrdersResult(
  period: ParsedPeriod,
  question: string,
): Promise<CompletedOrdersQueryResult> {
  const orders = await getCompletedOrdersByDateRange(period.start, period.end);

  return {
    kind: "completed_orders",
    question,
    range: {
      startDate: isoDay(period.start),
      endDate: isoDay(period.end),
      label: period.label,
    },
    orders,
    answer: buildAnswer(orders, period),
  };
}

export async function answerOrderQuestion(
  question: string,
  now: Date = new Date(),
): Promise<CompletedOrdersQueryResult> {
  let period = parseCompletedOrdersQuestion(question, now);
  period ??= await parsePeriodWithModel(question, now);

  if (!period) {
    throw new OrderQueryError(
      "Ask any completed-order question that includes a date period, like: Show completed orders from Aug 25 to Aug 26.",
    );
  }

  return resolveCompletedOrdersResult(period, question);
}

/**
 * Explicit-date-range entry point for UI controls (date pickers, quick
 * "today" buttons) that already know the exact period — skips the
 * question-text parsing/LLM fallback in answerOrderQuestion entirely, so it
 * can't misfire on an ambiguous phrase.
 */
export async function getCompletedOrdersForPeriod(
  startDate: string,
  endDate: string,
): Promise<CompletedOrdersQueryResult> {
  const start = parseIsoDay(startDate);
  const end = parseIsoDay(endDate);
  if (!start || !end) {
    throw new OrderQueryError("startDate and endDate must be in YYYY-MM-DD format.");
  }

  const period = makePeriod(start, end);
  return resolveCompletedOrdersResult(period, `Completed orders from ${period.label}`);
}
