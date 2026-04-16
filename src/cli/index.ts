#!/usr/bin/env node

import { createCliProgram } from "./program.js";

await createCliProgram().parseAsync();
