import { z } from "zod";
const id=z.string().min(1);
const optionalText=z.string().max(2000);
const money=z.number().int().nonnegative().nullable();
const auth=z.enum(["OM","OC","CONTRACT"]);
export const workflowCommandSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("reserve"),expires:z.string().min(1)}),
  z.object({kind:z.literal("release")}),
  z.object({kind:z.literal("assign"),email:z.email()}),
  z.object({kind:z.literal("confirm")}),
  z.object({kind:z.literal("configure"),billingId:id,billingContactId:id,signerContactId:id,paymentTermsDays:z.number().int().nonnegative(),authorizationKind:auth,responsibleEmail:z.email(),commissionPct:z.number().min(0).max(100).nullable()}),
  z.object({kind:z.literal("authorize"),url:z.url().regex(/^https?:\/\//i)}),
  z.object({kind:z.literal("purchase"),lineId:id,status:z.enum(["requested","confirmed","rejected","cancelled"]),costMinor:money,currency:z.string().nullable(),reference:z.string().min(1).max(1000),reason:optionalText}),
  z.object({kind:z.literal("receive"),url:z.url().regex(/^https?:\/\//i),lineIds:z.array(id).min(1),supersedes:z.string().optional(),duration:z.number().positive().nullable().optional(),width:z.number().int().positive().nullable().optional(),height:z.number().int().positive().nullable().optional()}),
  z.object({kind:z.literal("review"),materialId:id,review:z.enum(["technical","content"]),status:z.enum(["approved","rejected"]),reason:optionalText}),
  z.object({kind:z.literal("evidence"),lineId:id,url:z.url().regex(/^https?:\/\//i),evidenceKind:z.enum(["photo","supplier_report","play_log"]),from:z.string().min(1),to:z.string().min(1),takenAt:z.string().min(1)}),
  z.object({kind:z.literal("delivery"),lineId:id,evidenceId:z.string().nullable(),status:z.enum(["fulfilled","partial","incident","resolved"]),quantity:z.number().int().nonnegative(),resolution:optionalText}),
  z.object({kind:z.literal("amend"),reason:z.string().min(1).max(1000),paymentTermsDays:z.number().int().nonnegative(),notes:optionalText,authorizationKind:auth,commissionPct:z.number().min(0).max(100).nullable(),lines:z.array(z.object({id,starts:z.string().min(1),ends:z.string().min(1),slots:z.number().int().min(1).max(100),totalMinor:z.number().int().positive()})).min(1)})
]);
export type WorkflowCommand=z.infer<typeof workflowCommandSchema>;
