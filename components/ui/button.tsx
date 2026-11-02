import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 max-md:[&_svg]:size-[18px]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive-hover",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-surface-strong",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        // Below md every size grows to a finger: 44px for a button, 40px at the smallest.
        default: "h-9 px-4 py-2 max-md:h-11 max-md:text-[15px]",
        sm: "h-8 rounded-md px-3 text-xs max-md:h-10 max-md:px-3.5 max-md:text-sm",
        lg: "h-10 rounded-md px-6 max-md:h-12 max-md:text-[15px]",
        icon: "size-9 max-md:size-11",
        "icon-sm": "size-8 max-md:size-10",
      },
    },
    // A link reads inline with its sentence, so it never takes a button's height.
    compoundVariants: [
      {
        variant: "link",
        class: "max-md:h-auto max-md:p-0 max-md:text-[length:inherit]",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        data-variant={variant ?? "default"}
        // A bare <button> in a <form> defaults to type="submit", which would make every dialog Cancel an accidental submit.
        {...(asChild ? (type ? { type } : {}) : { type: type ?? "button" })}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
