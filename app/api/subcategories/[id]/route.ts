import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api-error";

async function update() {
  return NextResponse.json(
    { error: "Subcategories are part of the category tree. Edit the node under Categories." },
    { status: 410 }
  );
}

async function remove() {
  return NextResponse.json(
    { error: "Subcategories are part of the category tree. Delete the node under Categories." },
    { status: 410 }
  );
}

export const PATCH = withErrors(update);
export const DELETE = withErrors(remove);
