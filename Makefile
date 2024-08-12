app:
	@docker compose --project-name=faax -f ./deployment/docker-compose.yml up faax --build --force-recreate --remove-orphans -d

shutapp: 
	@docker compose --project-name=faax -f ./deployment/docker-compose.yml down