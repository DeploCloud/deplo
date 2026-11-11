-- The architectures a pulled image is published for (spec #176): what a mixed cluster fails it over by.
CREATE TABLE IF NOT EXISTS "image_architectures" (
	"image_ref" text NOT NULL,
	"arch" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "image_architectures_image_ref_arch_pk" PRIMARY KEY("image_ref","arch")
);
