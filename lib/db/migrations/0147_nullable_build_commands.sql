-- Tell "Deplo works this out" apart from "run nothing here".
--
-- Every one of these columns was NOT NULL, and the empty string carried the first
-- meaning all the way down to the agent ("empty => the method's own default /
-- detection"). So the existing empty strings ARE nulls, and become them here;
-- from now on an empty string is a deliberate choice to run no command.
ALTER TABLE "app_build" ALTER COLUMN "install_command" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_build" ALTER COLUMN "build_command" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_build" ALTER COLUMN "output_directory" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_build" ALTER COLUMN "start_command" DROP NOT NULL;--> statement-breakpoint
UPDATE "app_build" SET "install_command" = NULL WHERE "install_command" = '';--> statement-breakpoint
UPDATE "app_build" SET "build_command" = NULL WHERE "build_command" = '';--> statement-breakpoint
UPDATE "app_build" SET "output_directory" = NULL WHERE "output_directory" = '';--> statement-breakpoint
UPDATE "app_build" SET "start_command" = NULL WHERE "start_command" = '';
