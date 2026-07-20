import type { AgentPhase } from "./types.js";

export function inferAgentPhase(prompt: string, hasCompletedRun: boolean): AgentPhase {
  const value = prompt.toLowerCase();
  if (/\b(database|schema|migration|postgres|mysql|sqlite|table|column)\b/.test(value)) return "database_migration";
  if (/\b(production|prod)\b.*\b(deploy(?:ment|ing|ed)?|release|ship)\b|\b(deploy(?:ment|ing|ed)?|release|ship)\b.*\b(production|prod)\b/.test(value)) {
    return "production_deploy_prepare";
  }
  if (/\b(deploy(?:ment|ing|ed)?|release|hosting|docker|container)\b/.test(value)) return "deploy:prepare";
  if (/\b(test failure|failing test|build failure|build error|ci failure)\b/.test(value)) return "agent:after_test_failure";
  if (/\b(error|exception|crash|broken|debug|logs?)\b/.test(value)) return "agent:after_error";
  if (!hasCompletedRun || /\b(create|start|scaffold|new app|build an? app)\b/.test(value)) return "project:create";
  return "agent:before_edit";
}
