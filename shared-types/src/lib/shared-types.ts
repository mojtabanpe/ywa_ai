export interface TopicScore { viralScore: number; noveltyScore: number; usefulnessScore: number; persianAudienceScore: number; visualScore: number; totalScore: number; reason: string; }
export type ContentWorkflowStatus = 'DISCOVERED' | 'APPROVED' | 'SCRIPT_GENERATING' | 'SCRIPT_READY' | 'SCRIPT_FAILED';
export interface ScriptGenerationLog { id: string; level: 'INFO' | 'ERROR'; message: string; createdAt: string; }
export interface DiscoveryRunLog { id: string; level: 'INFO' | 'ERROR'; message: string; createdAt: string; }
export interface ReelScript { id: string; contentId: string; hook: string; narration: string; visualPlan: string; caption: string; cta: string; model: string; createdAt: string; updatedAt: string; }
export interface DiscoveredTopic { id: string; title: string; description: string | null; url: string; source: string; publishedAt: string | null; workflowStatus: ContentWorkflowStatus; scriptError: string | null; scriptProgress: number; scriptLogs: ScriptGenerationLog[]; score: TopicScore | null; reelScript: ReelScript | null; }
export interface DiscoveryRunResponse { id: string; status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'; itemCount: number; sourceCount: number; progress: number; currentStep: string | null; error: string | null; logs: DiscoveryRunLog[]; }
