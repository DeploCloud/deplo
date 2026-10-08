ALTER TABLE app_build_method_settings ADD COLUMN deplopack_version text;
--> statement-breakpoint
ALTER TABLE app_build_method_settings ADD COLUMN deplopack_provider text;
--> statement-breakpoint
ALTER TABLE app_build_method_settings ADD COLUMN deplopack_path text;
--> statement-breakpoint
CREATE TABLE app_deplopack_inputs (
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL,
  type text NOT NULL,
  PRIMARY KEY (app_id,env)
);
--> statement-breakpoint
CREATE TABLE app_deplopack_input_values (
  app_id text NOT NULL,
  env text NOT NULL,
  position integer NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (app_id,env,position),
  FOREIGN KEY (app_id,env) REFERENCES app_deplopack_inputs(app_id,env) ON DELETE CASCADE
);
