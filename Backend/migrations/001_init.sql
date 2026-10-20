-- 001_init.sql: core schema for the salon queue MVP.
-- Every salon-owned table carries salon_id, and cross-table references use
-- composite (id, salon_id) foreign keys so a row can never point at another
-- salon's data, even if application code has a bug.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------- salons
CREATE TABLE salons (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name                  text NOT NULL,
  address               text NOT NULL,
  phone                 text,
  lat                   double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                   double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  location              geography(Point, 4326)
                          GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,
  timezone              text NOT NULL DEFAULT 'Asia/Kolkata',
  buffer_minutes        integer NOT NULL DEFAULT 5  CHECK (buffer_minutes BETWEEN 0 AND 60),
  noshow_grace_minutes  integer NOT NULL DEFAULT 5  CHECK (noshow_grace_minutes BETWEEN 1 AND 60),
  -- requeue_once: first time a called customer misses the grace period they go
  -- to the back of the line; second time they are marked no_show.
  noshow_policy         text    NOT NULL DEFAULT 'requeue_once'
                          CHECK (noshow_policy IN ('requeue_once', 'mark_no_show')),
  turn_alert_minutes    integer NOT NULL DEFAULT 10 CHECK (turn_alert_minutes BETWEEN 0 AND 120),
  -- Joins from further away than this are rejected when the client sends a
  -- location. NULL disables the check.
  join_radius_m         integer DEFAULT 3000 CHECK (join_radius_m IS NULL OR join_radius_m > 0),
  joins_paused          boolean NOT NULL DEFAULT false,
  messaging_sender      text,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX salons_location_gix ON salons USING gist (location);

CREATE TABLE business_hours (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id  uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  weekday   smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
  opens     time NOT NULL,
  closes    time NOT NULL,
  CHECK (closes > opens),
  UNIQUE (salon_id, weekday, opens)
);
-- A salon-wide break is modelled as two intervals on the same day
-- (e.g. 10:00-14:00 and 15:00-21:00).

CREATE TABLE holidays (
  salon_id  uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  date      date NOT NULL,
  note      text,
  PRIMARY KEY (salon_id, date)
);

-- ---------------------------------------------------------------- people
CREATE TABLE customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'), -- E.164
  name           text CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 80),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE TABLE staff_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(email)),
  name           text NOT NULL,
  password_hash  text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Membership: one staff user can belong to several salons with a role in each.
CREATE TABLE staff_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id  uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  salon_id       uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('owner', 'receptionist', 'stylist')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_user_id, salon_id),
  UNIQUE (id, salon_id)
);

-- ---------------------------------------------------------------- catalogue
CREATE TABLE stylists (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id         uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  staff_member_id  uuid,
  display_name     text NOT NULL,
  status           text NOT NULL DEFAULT 'off'
                     CHECK (status IN ('available', 'busy', 'break', 'off')),
  break_until      timestamptz,
  sort_order       integer NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, salon_id),
  UNIQUE (staff_member_id),
  FOREIGN KEY (staff_member_id, salon_id) REFERENCES staff_members(id, salon_id) ON DELETE SET NULL (staff_member_id)
);

CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id         uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  price_paise      integer NOT NULL CHECK (price_paise >= 0),
  default_minutes  integer NOT NULL CHECK (default_minutes BETWEEN 1 AND 600),
  sort_order       integer NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, salon_id),
  UNIQUE (salon_id, name)
);

-- Which stylist offers which service, with an optional per-stylist duration.
CREATE TABLE stylist_services (
  salon_id        uuid NOT NULL,
  stylist_id      uuid NOT NULL,
  service_id      uuid NOT NULL,
  custom_minutes  integer CHECK (custom_minutes IS NULL OR custom_minutes BETWEEN 1 AND 600),
  PRIMARY KEY (stylist_id, service_id),
  FOREIGN KEY (stylist_id, salon_id) REFERENCES stylists(id, salon_id) ON DELETE CASCADE,
  FOREIGN KEY (service_id, salon_id) REFERENCES services(id, salon_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- queue
CREATE TABLE queue_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id              uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  customer_id           uuid REFERENCES customers(id) ON DELETE SET NULL,
  guest_name            text,            -- walk-ins added without the app
  source                text NOT NULL CHECK (source IN ('app', 'walk_in')),
  requested_stylist_id  uuid,            -- NULL = "any available"
  stylist_id            uuid NOT NULL,   -- assigned stylist
  status                text NOT NULL DEFAULT 'waiting'
                          CHECK (status IN ('waiting', 'called', 'in_service', 'done', 'no_show', 'left', 'cancelled')),
  position              integer NOT NULL,
  extra_minutes         integer NOT NULL DEFAULT 0 CHECK (extra_minutes BETWEEN 0 AND 600),
  skip_count            integer NOT NULL DEFAULT 0,
  est_start_at          timestamptz,     -- latest estimate, refreshed on every queue event
  initial_est_start_at  timestamptz,     -- estimate shown at join time (for accuracy reporting)
  joined_at             timestamptz NOT NULL DEFAULT now(),
  called_at             timestamptz,
  started_at            timestamptz,
  finished_at           timestamptz,
  ended_at              timestamptz,     -- left / no_show / cancelled
  turn_alert_sent_at    timestamptz,
  join_distance_m       integer,
  UNIQUE (id, salon_id),
  CHECK (customer_id IS NOT NULL OR guest_name IS NOT NULL),
  FOREIGN KEY (stylist_id, salon_id)           REFERENCES stylists(id, salon_id),
  FOREIGN KEY (requested_stylist_id, salon_id) REFERENCES stylists(id, salon_id)
);
CREATE INDEX queue_entries_salon_status_pos ON queue_entries (salon_id, status, position);
CREATE INDEX queue_entries_stylist_active   ON queue_entries (stylist_id, position)
  WHERE status IN ('waiting', 'called', 'in_service');
-- A customer holds at most one active place per salon.
CREATE UNIQUE INDEX queue_entries_one_active_per_customer ON queue_entries (salon_id, customer_id)
  WHERE status IN ('waiting', 'called', 'in_service') AND customer_id IS NOT NULL;
-- A stylist serves one customer at a time (see open question on colour processing).
CREATE UNIQUE INDEX queue_entries_one_in_service ON queue_entries (stylist_id) WHERE status = 'in_service';
CREATE UNIQUE INDEX queue_entries_one_called     ON queue_entries (stylist_id) WHERE status = 'called';

CREATE TABLE queue_entry_services (
  queue_entry_id       uuid NOT NULL,
  salon_id             uuid NOT NULL,
  service_id           uuid NOT NULL,
  name_snapshot        text NOT NULL,
  minutes_snapshot     integer NOT NULL CHECK (minutes_snapshot > 0),
  price_paise_snapshot integer NOT NULL CHECK (price_paise_snapshot >= 0),
  PRIMARY KEY (queue_entry_id, service_id),
  FOREIGN KEY (queue_entry_id, salon_id) REFERENCES queue_entries(id, salon_id) ON DELETE CASCADE,
  FOREIGN KEY (service_id, salon_id)     REFERENCES services(id, salon_id)
);

-- Append-only log of queue events; feeds the accuracy report and debugging.
CREATE TABLE queue_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  salon_id        uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  queue_entry_id  uuid,
  stylist_id      uuid,
  type            text NOT NULL,
  actor           text NOT NULL, -- 'customer:<id>', 'staff:<id>', 'system'
  data            jsonb NOT NULL DEFAULT '{}',
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queue_events_salon_at ON queue_events (salon_id, at);

-- ---------------------------------------------------------------- OTP
CREATE TABLE otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL,
  code_hash     text NOT NULL,   -- HMAC-SHA256(code) with a server secret; never the raw code
  channel       text NOT NULL,   -- provider that delivered it: 'dev', 'whatsapp', 'sms', ...
  attempts      integer NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  requested_ip  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone_created ON otp_challenges (phone, created_at DESC);
