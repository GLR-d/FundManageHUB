<template>
  <div class="page-heading">
    <div>
      <h1>关于</h1>
    </div>
  </div>
  <section class="surface-card about" aria-label="应用信息">
    <div class="about-row about-app-row">
      <span class="about-row-label">应用</span>
      <div class="about-app-info">
        <span class="about-mark">
          <UiIcon name="wallet" />
        </span>
        <h2>花销管理系统</h2>
      </div>
    </div>
    <div class="about-row">
      <span class="about-row-label">功能</span>
      <p>记录收入和支出，查看本月收支情况，并使用聊天功能。</p>
    </div>
    <div class="about-row">
      <span class="about-row-label">版本</span>
      <small><span class="about-version-prefix">版本 </span>0.1.0</small>
    </div>
  </section>
</template>
<script setup lang="ts">
import UiIcon from '@/components/ui/uiIcon.vue'
defineOptions({ name: 'About' })
</script>
<style scoped>
.about-row-label { display: none; }
.about {
  max-width: 680px;
}
.about-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 50px;
  height: 50px;
  color: var(--primary);
  background: var(--primary-soft);
  border-radius: 14px;
  margin-bottom: 20px;
}
.about h2 {
  font-size: 20px;
}
.about p {
  font-size: 14px;
  color: var(--muted);
  line-height: 1.8;
}
.about small {
  color: #a0a8b6;
}
@media(min-width:761px) {
  .page-heading,.about { max-width: 1100px; margin-inline: auto; }
  .about { max-width: 1100px; padding: 0 24px; border-radius: 24px; }
  .about-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 92px; padding: 22px 0; border-bottom: 1px solid var(--line); }
  .about-row:last-child { border-bottom: 0; }
  .about-row-label { display: block; flex: 0 0 90px; color: var(--text); font-size: 16px; font-weight: 550; line-height: 1.6; }
  .about-app-info { display: flex; align-items: center; justify-content: flex-end; gap: 12px; min-width: 0; }
  .about-mark { flex: 0 0 auto; width: 40px; height: 40px; margin: 0; border-radius: 12px; }
  .about h2 { margin: 0; color: #59657a; font-size: 16px; font-weight: 550; line-height: 1.6; overflow-wrap: anywhere; }
  .about p { max-width: 620px; margin: 0; color: #667187; font-size: 15px; line-height: 1.8; text-align: right; }
  .about small { color: #667187; font-size: 16px; line-height: 1.6; }
  .about-version-prefix { display: none; }
}
</style>
