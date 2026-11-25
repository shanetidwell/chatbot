// Types for the chatbot: test case input (one line of sample.jsonl) and the message output.
// Fields marked `?` appear in some records but not others.

export type Channel = "sms" | "email" | "voice";

// Channels we can actually send on. Voice isn't supported yet.
export type SupportedChannel = Exclude<Channel, "voice">;

// Which next_action each lifecycle stage leads to.
//   new  -> start_cadence      (e.g. prospect_welcome_day0)
//   open -> follow_up_in_days  (e.g. prospect_long_horizon_day3, value = N from "_dayN")
export type NextActionByStage = {
  new: { type: "start_cadence"; name: string };
  open: { type: "follow_up_in_days"; value: number };
};

export type LifecycleStage = keyof NextActionByStage; // "new" | "open"
export type NextAction = NextActionByStage[LifecycleStage];

// Which CTA type each primary_cta leads to.
//   book_tour -> schedule_tour  (both samples)
export type CtaTypeByPrimaryCta = {
  book_tour: "schedule_tour";
};

export type PrimaryCta = keyof CtaTypeByPrimaryCta; // "book_tour"
export type CtaType = CtaTypeByPrimaryCta[PrimaryCta]; // "schedule_tour"

export type Cta = {
  type: CtaType;
  options?: string[]; // reply choices, e.g. SMS ["Thu", "Fri"]
  link?: string; // e.g. email "https://oakridge.example/tour"
};

// The message the LLM returns. Email has a subject; SMS subject is null.
export type NextMessage =
  | { channel: "sms"; send_at: string; subject: null; body: string; cta: Cta }
  | { channel: "email"; send_at: string; subject: string; body: string; cta: Cta };

// Shape of one line in sample.jsonl.
export type TestCase = {
  task_id: string;
  persona: string; // e.g. "prospect"
  lifecycle_stage: LifecycleStage;
  consent: {
    email_opt_in: boolean;
    sms_opt_in: boolean;
    voice_opt_in: boolean;
  };
  channel_preferences: Channel[];
  input: {
    property_name: string;
    move_date_target: string; // "YYYY-MM-DD"
    last_interaction: string; // ISO-8601 UTC timestamp
    timezone: string; // IANA zone, e.g. "America/Chicago"
    language: string; // e.g. "en"
    profile: {
      first_name: string;
      city_interest?: string;
      amenity_interest?: string[];
    };
  };
  assertions: {
    required_states: string[]; // e.g. "consent_verified", "fair_housing_check_passed"
    constraints: {
      no_pii_leak: boolean;
      no_sensitive_discrimination?: boolean;
      include_opt_out_instructions: boolean;
      primary_cta: PrimaryCta;
    };
  };
  thresholds: {
    p95_latency_ms: number;
    personalization_score_min: number;
    reply_classification_f1_min: number;
    safety_violations_max: number;
  };
  expected: {
    // null when no message should be sent
    next_message: NextMessage | null;
    next_action: NextAction;
  };
};

// Checks that gate sending: the required_states plus the no-PII rule.
export type CheckName =
  | "consent_verified"
  | "fair_housing_check_passed"
  | "brand_style_applied"
  | "no_pii_leak";

// When a check fails we don't send and don't advance; instead the next step is to fix what failed
// (get consent, pass Fair Housing, apply brand style, remove PII).
export type BlockedAction = { type: "resolve_failed_checks"; failed_checks: CheckName[] };

// What processInput returns: the same shape as `expected`, plus the blocked case.
export type ProcessResult = {
  next_message: NextMessage | null;
  next_action: NextAction | BlockedAction;
};

// ---------------------------------------------------------------------------
// Content generation: the subject and raw body for the chosen channel.
// openAIContent (llm.ts) is the default; templateContent (templates.ts) is the deterministic
// fallback, and what the tests use.
// ---------------------------------------------------------------------------

// `source` says which generator actually wrote it (the OpenAI one falls back to templates).
export type MessageContent = { subject: string | null; body: string; source: "llm" | "template" };

// What's already decided before content is written.
export type ContentContext = { channel: SupportedChannel; send_at: string; cta: Cta };

export type ContentGenerator = (testCase: TestCase, ctx: ContentContext) => Promise<MessageContent>;
