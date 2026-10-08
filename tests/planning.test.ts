import { describe, expect, it } from "vitest";
import {
  accommodationCreateSchema,
  assignmentReorderSchema,
  budgetCreateSchema,
  budgetReconciles,
  reservationCreateSchema,
  todoCreateSchema,
} from "../src/lib/contracts";

describe("contrats planification", () => {
  it("réservation : title requise, type en liste fermée, montants en centimes", () => {
    expect(reservationCreateSchema.safeParse({ title: "Vol AF1234" }).success).toBe(true);
    expect(reservationCreateSchema.safeParse({}).success).toBe(false);
    expect(reservationCreateSchema.safeParse({ title: "x", type: "vol" }).success).toBe(false);
    expect(reservationCreateSchema.safeParse({ title: "x", type: "flight" }).success).toBe(true);
    expect(reservationCreateSchema.safeParse({ title: "x", cost_cents: -5 }).success).toBe(false);
    expect(reservationCreateSchema.safeParse({ title: "x", cost_cents: 10.5 }).success).toBe(false);
  });

  it("hébergement : jour de début et de fin requis", () => {
    expect(accommodationCreateSchema.safeParse({ start_day_id: 1, end_day_id: 2 }).success).toBe(true);
    expect(accommodationCreateSchema.safeParse({ start_day_id: 1 }).success).toBe(false);
    expect(accommodationCreateSchema.safeParse({ start_day_id: 1, end_day_id: 2, check_out: "2026-07-05" }).success).toBe(true);
  });

  it("réordonnancement : liste de place_id bornée", () => {
    expect(assignmentReorderSchema.safeParse({ place_ids: [3, 1, 2] }).success).toBe(true);
    expect(assignmentReorderSchema.safeParse({ place_ids: [] }).success).toBe(false);
    expect(assignmentReorderSchema.safeParse({ place_ids: [0] }).success).toBe(false);
  });

  it("budget : parts qui ne se réconcilient pas = refus (fail closed)", () => {
    expect(budgetReconciles(1000, [{ share_cents: 600 }, { share_cents: 400 }])).toBe(true);
    expect(budgetReconciles(1000, [{ share_cents: 600 }, { share_cents: 300 }])).toBe(false);
    expect(budgetCreateSchema.safeParse({ name: "Hôtel", total_cents: 1000, members: [{ user_id: 1, share_cents: 1000 }] }).success).toBe(true);
  });

  it("to-do : priorité 0..3", () => {
    expect(todoCreateSchema.safeParse({ name: "Visa", priority: 3 }).success).toBe(true);
    expect(todoCreateSchema.safeParse({ name: "Visa", priority: 9 }).success).toBe(false);
    expect(todoCreateSchema.safeParse({ name: "" }).success).toBe(false);
  });
});