import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api-error";

async function PATCH() {
  return NextResponse.json(
    { error: "Subcategories are part of the category tree. Edit the node under Categories." },
    { status: 410 }
  );
}

async function DELETE() {
  return NextResponse.json(
    { error: "Subcategories are part of the category tree. Delete the node under Categories." },
    { status: 410 }
  );
}

export const PATCH = withErrors(PATCH);
export const DELETE = withErrors(DELETE);
