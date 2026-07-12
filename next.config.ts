import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const config: NextConfig = {
  serverExternalPackages: ["postgres"],
};

export default withWorkflow(config);
