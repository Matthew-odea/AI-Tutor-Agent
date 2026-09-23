.PHONY: check e2e

check:
	pytest tests/ -v
	cd ai-tutor-frontend && npm run type-check && npm run lint && npm run test:run
	cd oral-assessment-instructor && npm run validate
	cd oral-assessment-student && npm run validate

e2e:
	cd e2e && npx playwright test
