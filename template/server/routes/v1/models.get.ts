import { modelsList } from "@just-ai/gateway";
import { exampleProfile } from "../../profiles/example";

export default defineEventHandler(() => modelsList(exampleProfile));
