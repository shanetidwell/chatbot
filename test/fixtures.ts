// The records from data/sample.jsonl, as typed TestCase objects for the tests to build on.
// The "sample.jsonl" test checks they stay identical to the file.

import type { TestCase } from "../src/types.ts";

// 1) Day-0 welcome: opted into SMS and prefers it -> short SMS with reply options.
export const welcomeDay0: TestCase = {
  task_id: "prospect_welcome_day0",
  persona: "prospect",
  lifecycle_stage: "new",
  consent: { email_opt_in: true, sms_opt_in: true, voice_opt_in: false },
  channel_preferences: ["sms", "email"],
  input: {
    property_name: "Oak Ridge Apartments",
    move_date_target: "2026-01-10",
    last_interaction: "2025-12-08T15:04:00Z",
    timezone: "America/Chicago",
    language: "en",
    profile: { first_name: "Taylor", city_interest: "Richardson, TX" },
  },
  assertions: {
    required_states: ["consent_verified", "fair_housing_check_passed", "brand_style_applied"],
    constraints: {
      no_pii_leak: true,
      no_sensitive_discrimination: true,
      include_opt_out_instructions: true,
      primary_cta: "book_tour",
    },
  },
  thresholds: {
    p95_latency_ms: 2000,
    personalization_score_min: 0.85,
    reply_classification_f1_min: 0.9,
    safety_violations_max: 0,
  },
  expected: {
    next_message: {
      channel: "sms",
      send_at: "2025-12-09T09:00:00-06:00",
      subject: null,
      body: "Hi Taylor—welcome to Oak Ridge! Tours are available this week. Would you like to book a time on Thursday or Friday? Reply 1 for Thu, 2 for Fri. Reply STOP to opt out.",
      cta: { type: "schedule_tour", options: ["Thu", "Fri"] },
    },
    next_action: { type: "start_cadence", name: "prospect_welcome_short_horizon" },
  },
};

// 2) Day-3 follow-up: not opted into SMS -> email with subject, link, and amenity personalization.
export const longHorizonDay3: TestCase = {
  task_id: "prospect_long_horizon_day3",
  persona: "prospect",
  lifecycle_stage: "open",
  consent: { email_opt_in: true, sms_opt_in: false, voice_opt_in: false },
  channel_preferences: ["email", "sms"],
  input: {
    property_name: "Oak Ridge Apartments",
    move_date_target: "2026-02-15",
    last_interaction: "2025-12-06T11:30:00Z",
    timezone: "America/Chicago",
    language: "en",
    profile: { first_name: "Taylor", amenity_interest: ["pool", "fitness"] },
  },
  assertions: {
    required_states: ["consent_verified", "fair_housing_check_passed", "brand_style_applied"],
    constraints: {
      no_pii_leak: true,
      include_opt_out_instructions: true,
      primary_cta: "book_tour",
    },
  },
  thresholds: {
    p95_latency_ms: 2000,
    personalization_score_min: 0.8,
    reply_classification_f1_min: 0.9,
    safety_violations_max: 0,
  },
  expected: {
    next_message: {
      channel: "email",
      send_at: "2025-12-09T10:00:00-06:00",
      subject: "Tour Oak Ridge—See the pool & fitness rooms you asked about",
      body: "Hi Taylor,\nSince you’re planning a mid‑February move, here’s a quick look at our pool and 24/7 fitness center. Book a visit this week to compare floor plans.\nBook now → https://oakridge.example/tour\nTo opt out of emails, click here or reply STOP.",
      cta: { type: "schedule_tour", link: "https://oakridge.example/tour" },
    },
    next_action: { type: "follow_up_in_days", value: 3 },
  },
};

// 3) Day-0 welcome in Spanish: SMS, written by the model in the user's language.
export const welcomeDay0Es: TestCase = {
  task_id: "prospect_welcome_day0",
  persona: "prospect",
  lifecycle_stage: "new",
  consent: { email_opt_in: true, sms_opt_in: true, voice_opt_in: false },
  channel_preferences: ["sms", "email"],
  input: {
    property_name: "Lomas del Río Apartments",
    move_date_target: "2026-03-05",
    last_interaction: "2025-12-15T18:20:00Z",
    timezone: "America/Chicago",
    language: "es",
    profile: { first_name: "Sofía", city_interest: "San Antonio, TX" },
  },
  assertions: {
    required_states: ["consent_verified", "fair_housing_check_passed", "brand_style_applied"],
    constraints: {
      no_pii_leak: true,
      no_sensitive_discrimination: true,
      include_opt_out_instructions: true,
      primary_cta: "book_tour",
    },
  },
  thresholds: {
    p95_latency_ms: 2000,
    personalization_score_min: 0.85,
    reply_classification_f1_min: 0.9,
    safety_violations_max: 0,
  },
  expected: {
    next_message: {
      channel: "sms",
      send_at: "2025-12-16T09:00:00-06:00",
      subject: null,
      body: "Hola Sofía, te damos la bienvenida a Lomas del Río. Hay visitas disponibles esta semana. ¿Te gustaría reservar una visita el jueves o el viernes? Responde 1 para jueves, 2 para viernes. Responde STOP para cancelar.",
      cta: { type: "schedule_tour", options: ["Thu", "Fri"] },
    },
    next_action: { type: "start_cadence", name: "prospect_welcome_short_horizon" },
  },
};

// 4) Day-3 follow-up in Spanish: email with three amenities and an accented property name.
export const longHorizonDay3Es: TestCase = {
  task_id: "prospect_long_horizon_day3",
  persona: "prospect",
  lifecycle_stage: "open",
  consent: { email_opt_in: true, sms_opt_in: false, voice_opt_in: false },
  channel_preferences: ["email", "sms"],
  input: {
    property_name: "Lomas del Río Apartments",
    move_date_target: "2026-03-25",
    last_interaction: "2025-12-12T16:00:00Z",
    timezone: "America/Chicago",
    language: "es",
    profile: { first_name: "Mateo", amenity_interest: ["pool", "fitness", "spa"] },
  },
  assertions: {
    required_states: ["consent_verified", "fair_housing_check_passed", "brand_style_applied"],
    constraints: {
      no_pii_leak: true,
      include_opt_out_instructions: true,
      primary_cta: "book_tour",
    },
  },
  thresholds: {
    p95_latency_ms: 2000,
    personalization_score_min: 0.8,
    reply_classification_f1_min: 0.9,
    safety_violations_max: 0,
  },
  expected: {
    next_message: {
      channel: "email",
      send_at: "2025-12-15T10:00:00-06:00",
      subject: "Visita Lomas del Río—Conoce las áreas de piscina, gimnasio y spa por las que preguntaste",
      body: "Hola Mateo,\nComo planeas mudarte a finales de marzo, aquí tienes un vistazo a nuestras áreas de piscina, gimnasio y spa. Reserva una visita esta semana para comparar planos.\nReserva ahora → https://lomasdelrio.example/tour\nPara dejar de recibir correos, haz clic aquí o responde STOP.",
      cta: { type: "schedule_tour", link: "https://lomasdelrio.example/tour" },
    },
    next_action: { type: "follow_up_in_days", value: 3 },
  },
};
