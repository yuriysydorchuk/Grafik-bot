-- Grafik-bot — bootstrap database schema (PostgreSQL), schema-only.
--
-- GENERATED from the live schema:
--   pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges --no-comments
--   (PG17-only SET lines stripped for PostgreSQL 16 compatibility)
--
-- Source of truth for the schema is lib/db/src/schema/workers.ts.
-- Regenerate this file after schema changes (see docs/infrastructure/DATABASE.md).
-- Apply to a fresh DB:  psql "$DATABASE_URL" -f deploy/schema.sql
-- Regenerated: 2026-06-19.

--
-- PostgreSQL database dump
--

\restrict RdnwbhlGwjMPearL4OH50EEDTcYxOdnbQQeSzZMr23g5KgZz5dYIohieyltR1Yv

-- Dumped from database version 17.10 (Homebrew)
-- Dumped by pg_dump version 17.10 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: day_of_week; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.day_of_week AS ENUM (
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'sat',
    'sun'
);


--
-- Name: entry_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.entry_status AS ENUM (
    'scheduled',
    'present',
    'absent'
);


--
-- Name: schedule_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.schedule_status AS ENUM (
    'draft',
    'approved'
);


--
-- Name: shift; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.shift AS ENUM (
    '1',
    '2',
    '3',
    '4',
    '5',
    '6'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: absence_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.absence_requests (
    id integer NOT NULL,
    worker_id integer NOT NULL,
    week_start date NOT NULL,
    day_of_week public.day_of_week NOT NULL,
    shift public.shift NOT NULL,
    reason text,
    status text DEFAULT 'pending'::text NOT NULL,
    substitute_worker_id integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: absence_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.absence_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: absence_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.absence_requests_id_seq OWNED BY public.absence_requests.id;


--
-- Name: admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admins (
    id integer NOT NULL,
    telegram_id text,
    name text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    username text,
    password_hash text,
    role text DEFAULT 'owner'::text NOT NULL,
    invite_code text,
    is_main boolean DEFAULT false NOT NULL,
    language text
);


--
-- Name: admins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admins_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admins_id_seq OWNED BY public.admins.id;


--
-- Name: availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.availability (
    id integer NOT NULL,
    full_name_raw text NOT NULL,
    week_start date NOT NULL,
    day_of_week public.day_of_week NOT NULL,
    shift public.shift NOT NULL,
    submitted_at timestamp without time zone NOT NULL,
    worker_id integer,
    source text DEFAULT 'sheets'::text NOT NULL
);


--
-- Name: availability_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.availability_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: availability_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.availability_id_seq OWNED BY public.availability.id;


--
-- Name: bot_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_messages (
    id integer NOT NULL,
    chat_id text NOT NULL,
    message_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: bot_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bot_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bot_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bot_messages_id_seq OWNED BY public.bot_messages.id;


--
-- Name: candidate_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.candidate_activity (
    id integer NOT NULL,
    candidate_id integer NOT NULL,
    admin_id integer,
    kind text NOT NULL,
    detail text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: candidate_activity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.candidate_activity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: candidate_activity_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.candidate_activity_id_seq OWNED BY public.candidate_activity.id;


--
-- Name: candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.candidates (
    id integer NOT NULL,
    referrer_worker_id integer,
    full_name text NOT NULL,
    telegram_id text,
    phone text,
    factory_id integer,
    stage text DEFAULT 'new'::text NOT NULL,
    worker_id integer,
    bonus_amount real,
    bonus_paid boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    funnel_id integer,
    assigned_admin_id integer,
    next_action_at timestamp without time zone,
    email text
);


--
-- Name: candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.candidates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: candidates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.candidates_id_seq OWNED BY public.candidates.id;


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: companies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.companies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: companies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.companies_id_seq OWNED BY public.companies.id;


--
-- Name: document_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_types (
    id integer NOT NULL,
    name text NOT NULL,
    required boolean DEFAULT true NOT NULL,
    has_expiry boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: document_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_types_id_seq OWNED BY public.document_types.id;


--
-- Name: driver_shift_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_shift_assignments (
    id integer NOT NULL,
    week_id integer NOT NULL,
    factory_id integer NOT NULL,
    day_of_week public.day_of_week NOT NULL,
    shift public.shift NOT NULL,
    driver_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: driver_shift_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.driver_shift_assignments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: driver_shift_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.driver_shift_assignments_id_seq OWNED BY public.driver_shift_assignments.id;


--
-- Name: driver_trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_trips (
    id integer NOT NULL,
    driver_id integer NOT NULL,
    week_id integer NOT NULL,
    factory_id integer NOT NULL,
    day_of_week public.day_of_week NOT NULL,
    shift public.shift NOT NULL,
    trip_date date NOT NULL,
    pickup_started_at timestamp without time zone,
    arrived_factory_at timestamp without time zone,
    late_to_pickup boolean DEFAULT false,
    late_to_factory boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: driver_trips_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.driver_trips_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: driver_trips_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.driver_trips_id_seq OWNED BY public.driver_trips.id;


--
-- Name: drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drivers (
    id integer NOT NULL,
    telegram_id text,
    name text NOT NULL,
    phone text,
    vehicle text,
    is_head_driver boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    invite_code text,
    username text,
    language text
);


--
-- Name: drivers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.drivers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drivers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.drivers_id_seq OWNED BY public.drivers.id;


--
-- Name: factories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factories (
    id integer NOT NULL,
    name text NOT NULL,
    address text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    shift1_start text,
    shift2_start text,
    shift3_start text,
    client_email text,
    shift_count integer DEFAULT 3 NOT NULL,
    uses_availability boolean DEFAULT true NOT NULL,
    shifts jsonb DEFAULT '[]'::jsonb NOT NULL,
    invoice_rate real,
    stops jsonb DEFAULT '[]'::jsonb NOT NULL,
    company_id integer,
    gen_mode text DEFAULT 'availability'::text NOT NULL,
    uses_positions boolean DEFAULT false NOT NULL,
    uses_gender boolean DEFAULT false NOT NULL
);


--
-- Name: factories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factories_id_seq OWNED BY public.factories.id;


--
-- Name: factory_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factory_orders (
    id integer NOT NULL,
    factory_id integer NOT NULL,
    week_start date NOT NULL,
    day_of_week public.day_of_week NOT NULL,
    shift public.shift NOT NULL,
    workers_needed integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    requirements jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: factory_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factory_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factory_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factory_orders_id_seq OWNED BY public.factory_orders.id;


--
-- Name: factory_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factory_positions (
    id integer NOT NULL,
    factory_id integer NOT NULL,
    position_id integer NOT NULL,
    rate real,
    sort_order integer DEFAULT 0 NOT NULL,
    invoice_rate real
);


--
-- Name: factory_positions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factory_positions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factory_positions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factory_positions_id_seq OWNED BY public.factory_positions.id;


--
-- Name: funnels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.funnels (
    id integer NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'custom'::text NOT NULL,
    stages jsonb DEFAULT '[]'::jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: funnels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.funnels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: funnels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.funnels_id_seq OWNED BY public.funnels.id;


--
-- Name: hours_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hours_disputes (
    id integer NOT NULL,
    worker_id integer NOT NULL,
    message text,
    photo_file_id text,
    status text DEFAULT 'new'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    resolved_at timestamp without time zone,
    month text,
    items jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: hours_disputes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hours_disputes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hours_disputes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hours_disputes_id_seq OWNED BY public.hours_disputes.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id integer NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text,
    audience text NOT NULL,
    read_by jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.positions (
    id integer NOT NULL,
    name text NOT NULL,
    color text DEFAULT 'slate'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: positions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.positions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: positions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.positions_id_seq OWNED BY public.positions.id;


--
-- Name: schedule_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_approvals (
    id integer NOT NULL,
    week_id integer NOT NULL,
    factory_id integer NOT NULL,
    approved_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: schedule_approvals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schedule_approvals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schedule_approvals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schedule_approvals_id_seq OWNED BY public.schedule_approvals.id;


--
-- Name: schedule_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_entries (
    id integer NOT NULL,
    week_id integer NOT NULL,
    worker_id integer NOT NULL,
    factory_id integer NOT NULL,
    day_of_week public.day_of_week NOT NULL,
    shift public.shift NOT NULL,
    status public.entry_status DEFAULT 'scheduled'::public.entry_status NOT NULL,
    absence_reason text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    picked_up_by integer,
    hours_override real
);


--
-- Name: schedule_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schedule_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schedule_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schedule_entries_id_seq OWNED BY public.schedule_entries.id;


--
-- Name: schedule_weeks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_weeks (
    id integer NOT NULL,
    week_start date NOT NULL,
    status public.schedule_status DEFAULT 'draft'::public.schedule_status NOT NULL,
    drive_file_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    approved_at timestamp without time zone
);


--
-- Name: schedule_weeks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schedule_weeks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schedule_weeks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schedule_weeks_id_seq OWNED BY public.schedule_weeks.id;


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: unplanned_workers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unplanned_workers (
    id integer NOT NULL,
    week_id integer NOT NULL,
    driver_id integer NOT NULL,
    factory_id integer NOT NULL,
    day_of_week public.day_of_week NOT NULL,
    shift public.shift NOT NULL,
    worker_name text NOT NULL,
    worker_id integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: unplanned_workers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.unplanned_workers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: unplanned_workers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.unplanned_workers_id_seq OWNED BY public.unplanned_workers.id;


--
-- Name: user_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_states (
    telegram_id text NOT NULL,
    action text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: worker_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_documents (
    id integer NOT NULL,
    worker_id integer NOT NULL,
    doc_type_id integer,
    title text NOT NULL,
    status text DEFAULT 'present'::text NOT NULL,
    number text,
    expires_at date,
    file_url text,
    note text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    file_path text,
    file_name text,
    file_mime text
);


--
-- Name: worker_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.worker_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: worker_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.worker_documents_id_seq OWNED BY public.worker_documents.id;


--
-- Name: workers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workers (
    id integer NOT NULL,
    full_name text NOT NULL,
    telegram_id text,
    worker_code text,
    status text DEFAULT 'active'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    fired_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    factory_id integer,
    hourly_rate real DEFAULT 31.5 NOT NULL,
    is_student boolean DEFAULT false NOT NULL,
    under_26 boolean DEFAULT false NOT NULL,
    language text,
    company_id integer,
    position_id integer,
    gender text,
    fixed_shift text
);


--
-- Name: workers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workers_id_seq OWNED BY public.workers.id;


--
-- Name: absence_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.absence_requests ALTER COLUMN id SET DEFAULT nextval('public.absence_requests_id_seq'::regclass);


--
-- Name: admins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins ALTER COLUMN id SET DEFAULT nextval('public.admins_id_seq'::regclass);


--
-- Name: availability id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability ALTER COLUMN id SET DEFAULT nextval('public.availability_id_seq'::regclass);


--
-- Name: bot_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_messages ALTER COLUMN id SET DEFAULT nextval('public.bot_messages_id_seq'::regclass);


--
-- Name: candidate_activity id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidate_activity ALTER COLUMN id SET DEFAULT nextval('public.candidate_activity_id_seq'::regclass);


--
-- Name: candidates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates ALTER COLUMN id SET DEFAULT nextval('public.candidates_id_seq'::regclass);


--
-- Name: companies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies ALTER COLUMN id SET DEFAULT nextval('public.companies_id_seq'::regclass);


--
-- Name: document_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_types ALTER COLUMN id SET DEFAULT nextval('public.document_types_id_seq'::regclass);


--
-- Name: driver_shift_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_shift_assignments ALTER COLUMN id SET DEFAULT nextval('public.driver_shift_assignments_id_seq'::regclass);


--
-- Name: driver_trips id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_trips ALTER COLUMN id SET DEFAULT nextval('public.driver_trips_id_seq'::regclass);


--
-- Name: drivers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers ALTER COLUMN id SET DEFAULT nextval('public.drivers_id_seq'::regclass);


--
-- Name: factories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factories ALTER COLUMN id SET DEFAULT nextval('public.factories_id_seq'::regclass);


--
-- Name: factory_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_orders ALTER COLUMN id SET DEFAULT nextval('public.factory_orders_id_seq'::regclass);


--
-- Name: factory_positions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_positions ALTER COLUMN id SET DEFAULT nextval('public.factory_positions_id_seq'::regclass);


--
-- Name: funnels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnels ALTER COLUMN id SET DEFAULT nextval('public.funnels_id_seq'::regclass);


--
-- Name: hours_disputes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hours_disputes ALTER COLUMN id SET DEFAULT nextval('public.hours_disputes_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: positions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions ALTER COLUMN id SET DEFAULT nextval('public.positions_id_seq'::regclass);


--
-- Name: schedule_approvals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_approvals ALTER COLUMN id SET DEFAULT nextval('public.schedule_approvals_id_seq'::regclass);


--
-- Name: schedule_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_entries ALTER COLUMN id SET DEFAULT nextval('public.schedule_entries_id_seq'::regclass);


--
-- Name: schedule_weeks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_weeks ALTER COLUMN id SET DEFAULT nextval('public.schedule_weeks_id_seq'::regclass);


--
-- Name: unplanned_workers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unplanned_workers ALTER COLUMN id SET DEFAULT nextval('public.unplanned_workers_id_seq'::regclass);


--
-- Name: worker_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_documents ALTER COLUMN id SET DEFAULT nextval('public.worker_documents_id_seq'::regclass);


--
-- Name: workers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers ALTER COLUMN id SET DEFAULT nextval('public.workers_id_seq'::regclass);


--
-- Name: absence_requests absence_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.absence_requests
    ADD CONSTRAINT absence_requests_pkey PRIMARY KEY (id);


--
-- Name: admins admins_invite_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_invite_code_key UNIQUE (invite_code);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);


--
-- Name: admins admins_telegram_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_telegram_id_key UNIQUE (telegram_id);


--
-- Name: availability availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_pkey PRIMARY KEY (id);


--
-- Name: bot_messages bot_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_messages
    ADD CONSTRAINT bot_messages_pkey PRIMARY KEY (id);


--
-- Name: candidate_activity candidate_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidate_activity
    ADD CONSTRAINT candidate_activity_pkey PRIMARY KEY (id);


--
-- Name: candidates candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: document_types document_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_types
    ADD CONSTRAINT document_types_pkey PRIMARY KEY (id);


--
-- Name: driver_shift_assignments driver_shift_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_shift_assignments
    ADD CONSTRAINT driver_shift_assignments_pkey PRIMARY KEY (id);


--
-- Name: driver_trips driver_trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_trips
    ADD CONSTRAINT driver_trips_pkey PRIMARY KEY (id);


--
-- Name: drivers drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);


--
-- Name: drivers drivers_telegram_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_telegram_id_key UNIQUE (telegram_id);


--
-- Name: factories factories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factories
    ADD CONSTRAINT factories_pkey PRIMARY KEY (id);


--
-- Name: factory_orders factory_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_orders
    ADD CONSTRAINT factory_orders_pkey PRIMARY KEY (id);


--
-- Name: factory_positions factory_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_positions
    ADD CONSTRAINT factory_positions_pkey PRIMARY KEY (id);


--
-- Name: funnels funnels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnels
    ADD CONSTRAINT funnels_pkey PRIMARY KEY (id);


--
-- Name: hours_disputes hours_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hours_disputes
    ADD CONSTRAINT hours_disputes_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: positions positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_pkey PRIMARY KEY (id);


--
-- Name: schedule_approvals schedule_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_approvals
    ADD CONSTRAINT schedule_approvals_pkey PRIMARY KEY (id);


--
-- Name: schedule_entries schedule_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_entries
    ADD CONSTRAINT schedule_entries_pkey PRIMARY KEY (id);


--
-- Name: schedule_weeks schedule_weeks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_weeks
    ADD CONSTRAINT schedule_weeks_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: unplanned_workers unplanned_workers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unplanned_workers
    ADD CONSTRAINT unplanned_workers_pkey PRIMARY KEY (id);


--
-- Name: user_states user_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_states
    ADD CONSTRAINT user_states_pkey PRIMARY KEY (telegram_id);


--
-- Name: worker_documents worker_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_documents
    ADD CONSTRAINT worker_documents_pkey PRIMARY KEY (id);


--
-- Name: workers workers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_pkey PRIMARY KEY (id);


--
-- Name: workers workers_telegram_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_telegram_id_key UNIQUE (telegram_id);


--
-- Name: workers workers_worker_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_worker_code_key UNIQUE (worker_code);


--
-- Name: admins_username_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admins_username_unique ON public.admins USING btree (username);


--
-- Name: bot_messages_chat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bot_messages_chat_idx ON public.bot_messages USING btree (chat_id);


--
-- Name: bot_messages_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bot_messages_created_idx ON public.bot_messages USING btree (created_at);


--
-- Name: drivers_invite_code_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX drivers_invite_code_unique ON public.drivers USING btree (invite_code);


--
-- Name: idx_cand_activity_cand; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cand_activity_cand ON public.candidate_activity USING btree (candidate_id);


--
-- Name: idx_worker_docs_worker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_worker_docs_worker ON public.worker_documents USING btree (worker_id);


--
-- Name: schedule_approvals_week_factory; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX schedule_approvals_week_factory ON public.schedule_approvals USING btree (week_id, factory_id);


--
-- Name: absence_requests absence_requests_substitute_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.absence_requests
    ADD CONSTRAINT absence_requests_substitute_worker_id_fkey FOREIGN KEY (substitute_worker_id) REFERENCES public.workers(id);


--
-- Name: absence_requests absence_requests_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.absence_requests
    ADD CONSTRAINT absence_requests_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id);


--
-- Name: availability availability_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id);


--
-- Name: candidate_activity candidate_activity_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidate_activity
    ADD CONSTRAINT candidate_activity_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id);


--
-- Name: candidate_activity candidate_activity_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidate_activity
    ADD CONSTRAINT candidate_activity_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: candidates candidates_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.admins(id);


--
-- Name: candidates candidates_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_factory_id_fkey FOREIGN KEY (factory_id) REFERENCES public.factories(id);


--
-- Name: candidates candidates_funnel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_funnel_id_fkey FOREIGN KEY (funnel_id) REFERENCES public.funnels(id);


--
-- Name: candidates candidates_referrer_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_referrer_worker_id_fkey FOREIGN KEY (referrer_worker_id) REFERENCES public.workers(id);


--
-- Name: candidates candidates_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id);


--
-- Name: driver_shift_assignments driver_shift_assignments_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_shift_assignments
    ADD CONSTRAINT driver_shift_assignments_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id);


--
-- Name: driver_shift_assignments driver_shift_assignments_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_shift_assignments
    ADD CONSTRAINT driver_shift_assignments_factory_id_fkey FOREIGN KEY (factory_id) REFERENCES public.factories(id);


--
-- Name: driver_shift_assignments driver_shift_assignments_week_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_shift_assignments
    ADD CONSTRAINT driver_shift_assignments_week_id_fkey FOREIGN KEY (week_id) REFERENCES public.schedule_weeks(id);


--
-- Name: driver_trips driver_trips_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_trips
    ADD CONSTRAINT driver_trips_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id);


--
-- Name: driver_trips driver_trips_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_trips
    ADD CONSTRAINT driver_trips_factory_id_fkey FOREIGN KEY (factory_id) REFERENCES public.factories(id);


--
-- Name: driver_trips driver_trips_week_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_trips
    ADD CONSTRAINT driver_trips_week_id_fkey FOREIGN KEY (week_id) REFERENCES public.schedule_weeks(id);


--
-- Name: factories factories_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factories
    ADD CONSTRAINT factories_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: factory_orders factory_orders_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_orders
    ADD CONSTRAINT factory_orders_factory_id_fkey FOREIGN KEY (factory_id) REFERENCES public.factories(id);


--
-- Name: factory_positions factory_positions_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_positions
    ADD CONSTRAINT factory_positions_factory_id_fkey FOREIGN KEY (factory_id) REFERENCES public.factories(id) ON DELETE CASCADE;


--
-- Name: factory_positions factory_positions_position_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_positions
    ADD CONSTRAINT factory_positions_position_id_fkey FOREIGN KEY (position_id) REFERENCES public.positions(id);


--
-- Name: hours_disputes hours_disputes_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hours_disputes
    ADD CONSTRAINT hours_disputes_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id);


--
-- Name: schedule_approvals schedule_approvals_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_approvals
    ADD CONSTRAINT schedule_approvals_factory_id_fkey FOREIGN KEY (factory_id) REFERENCES public.factories(id);


--
-- Name: schedule_approvals schedule_approvals_week_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_approvals
    ADD CONSTRAINT schedule_approvals_week_id_fkey FOREIGN KEY (week_id) REFERENCES public.schedule_weeks(id) ON DELETE CASCADE;


--
-- Name: schedule_entries schedule_entries_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_entries
    ADD CONSTRAINT schedule_entries_factory_id_fkey FOREIGN KEY (factory_id) REFERENCES public.factories(id);


--
-- Name: schedule_entries schedule_entries_picked_up_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_entries
    ADD CONSTRAINT schedule_entries_picked_up_by_fkey FOREIGN KEY (picked_up_by) REFERENCES public.drivers(id);


--
-- Name: schedule_entries schedule_entries_week_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_entries
    ADD CONSTRAINT schedule_entries_week_id_fkey FOREIGN KEY (week_id) REFERENCES public.schedule_weeks(id);


--
-- Name: schedule_entries schedule_entries_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_entries
    ADD CONSTRAINT schedule_entries_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id);


--
-- Name: unplanned_workers unplanned_workers_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unplanned_workers
    ADD CONSTRAINT unplanned_workers_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id);


--
-- Name: unplanned_workers unplanned_workers_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unplanned_workers
    ADD CONSTRAINT unplanned_workers_factory_id_fkey FOREIGN KEY (factory_id) REFERENCES public.factories(id);


--
-- Name: unplanned_workers unplanned_workers_week_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unplanned_workers
    ADD CONSTRAINT unplanned_workers_week_id_fkey FOREIGN KEY (week_id) REFERENCES public.schedule_weeks(id);


--
-- Name: unplanned_workers unplanned_workers_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unplanned_workers
    ADD CONSTRAINT unplanned_workers_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id);


--
-- Name: worker_documents worker_documents_doc_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_documents
    ADD CONSTRAINT worker_documents_doc_type_id_fkey FOREIGN KEY (doc_type_id) REFERENCES public.document_types(id);


--
-- Name: worker_documents worker_documents_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_documents
    ADD CONSTRAINT worker_documents_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id) ON DELETE CASCADE;


--
-- Name: workers workers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: workers workers_factory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_factory_id_fkey FOREIGN KEY (factory_id) REFERENCES public.factories(id);


--
-- Name: workers workers_position_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_position_id_fkey FOREIGN KEY (position_id) REFERENCES public.positions(id);


--
-- PostgreSQL database dump complete
--

\unrestrict RdnwbhlGwjMPearL4OH50EEDTcYxOdnbQQeSzZMr23g5KgZz5dYIohieyltR1Yv

