import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { DiscoveredTopic, DiscoveryRunResponse, ReelScript } from '@ywa-ai/shared-types';

@Component({ selector: 'app-root', imports: [], templateUrl: './app.html', styleUrl: './app.scss' })
export class App {
  private readonly http = inject(HttpClient);
  readonly topics = signal<DiscoveredTopic[]>([]);
  readonly run = signal<DiscoveryRunResponse | null>(null);
  readonly loading = signal(false);
  readonly actionId = signal<string | null>(null);
  readonly selectedScript = signal<ReelScript | null>(null);
  readonly selectedPrompt = signal<string | null>(null);
  readonly promptCopied = signal(false);
  private progressRefreshTimer?: ReturnType<typeof setTimeout>;
  private discoveryRefreshTimer?: ReturnType<typeof setTimeout>;
  readonly activeTopics = computed(() => this.topics().filter((topic) => topic.workflowStatus !== 'DISCOVERED'));
  readonly newTopics = computed(() => this.topics().filter((topic) => topic.workflowStatus === 'DISCOVERED'));
  constructor() { this.refresh(); }
  refresh() { this.http.get<DiscoveredTopic[]>('http://localhost:3000/api/discovery/topics').subscribe({ next: (topics) => { this.topics.set(topics); clearTimeout(this.progressRefreshTimer); if (topics.some((topic) => topic.workflowStatus === 'SCRIPT_GENERATING')) this.progressRefreshTimer = setTimeout(() => this.refresh(), 2_000); }, error: () => this.topics.set([]) }); }
  startDiscovery() { this.loading.set(true); this.http.post<DiscoveryRunResponse>('http://localhost:3000/api/discovery/runs', {}).subscribe({ next: (run) => { this.run.set(run); this.loading.set(false); this.pollDiscovery(run.id); }, error: () => this.loading.set(false) }); }
  pollDiscovery(id: string) {
    this.http.get<DiscoveryRunResponse>(`http://localhost:3000/api/discovery/runs/${id}`).subscribe({ next: (run) => {
      this.run.set(run);
      clearTimeout(this.discoveryRefreshTimer);
      if (run.status === 'QUEUED' || run.status === 'RUNNING') this.discoveryRefreshTimer = setTimeout(() => this.pollDiscovery(id), 1_500);
      else if (run.status === 'COMPLETED') this.refresh();
    } });
  }
  approve(topic: DiscoveredTopic) {
    this.actionId.set(topic.id);
    this.http.post<DiscoveredTopic>(`http://localhost:3000/api/discovery/topics/${topic.id}/approve`, {}).subscribe({ next: () => { this.actionId.set(null); this.refresh(); }, error: () => this.actionId.set(null) });
  }
  createPrompt(topic: DiscoveredTopic) {
    this.promptCopied.set(false);
    this.selectedPrompt.set(`برای موضوع زیر یک سناریوی دقیق و جذاب برای ریلز اینستاگرام فارسی، حدود ۴۰ ثانیه، بساز.\n\nموضوع: ${topic.title}\nمنبع: ${topic.source}\nتوضیح منبع: ${topic.description || 'توضیحی در دسترس نیست.'}\n\nفقط JSON معتبر برگردان و هیچ متن دیگری ننویس:\n{\n  "hook": "هوک کوتاه و کنجکاوی‌برانگیز",\n  "narration": "متن روان فارسی برای گویندگی، حداکثر ۱۱۵ کلمه، بدون ادعای ساختگی",\n  "visualPlan": "۳ تا ۵ پلان کوتاه تصویری، هر پلان در یک خط",\n  "caption": "کپشن کوتاه فارسی",\n  "cta": "دعوت به اقدام کوتاه"\n}`);
  }
  async copyPrompt() { const prompt = this.selectedPrompt(); if (!prompt) return; await navigator.clipboard.writeText(prompt); this.promptCopied.set(true); }
  showScript(topic: DiscoveredTopic) { if (topic.reelScript) this.selectedScript.set(topic.reelScript); }
}
