# Load KEY=value lines from a local, git-ignored .env file (e.g. ANTHROPIC_API_KEY).
env_file = File.join(__dir__, ".env")
if File.exist?(env_file)
  File.foreach(env_file) do |line|
    next if line.strip.empty? || line.lstrip.start_with?("#")
    key, value = line.strip.split("=", 2)
    ENV[key.sub(/\Aexport\s+/, "")] ||= value.to_s.gsub(/\A["']|["']\z/, "") if key && value
  end
end

require_relative "lib/importers"

namespace :import do
  desc "Download the official UNESCO World Heritage List into SQLite"
  task(:unesco) { Importers::Unesco.run }

  desc "Link sites to Wikidata items / English Wikipedia articles (P757)"
  task(:wikidata) { Importers::Wikidata.run }

  desc "Fetch Wikipedia intros and lead images, then choose a display image"
  task(:wikipedia) { Importers::Wikipedia.run }

  desc "Write fresh descriptions with Claude (needs ANTHROPIC_API_KEY; LIMIT=n, FORCE=1)"
  task :descriptions do
    require_relative "lib/describer"
    Describer.run
  end

  desc "UNESCO + Wikidata + Wikipedia (everything except descriptions)"
  task data: %i[unesco wikidata wikipedia]

  desc "Full import including Claude descriptions"
  task all: %i[data descriptions]
end

desc "Show import coverage"
task :stats do
  s = DB.connection[:sites]
  total = s.count
  puts "Sites:        #{total}"
  s.group_and_count(:category).each { |r| puts "  #{r[:category].ljust(10)} #{r[:count]}" }
  puts "In danger:    #{s.where(danger: true).count}"
  puts "Wikidata:     #{s.exclude(wikidata_id: nil).count}"
  puts "Wikipedia:    #{s.exclude(wikipedia_title: nil).count}"
  puts "Image:        #{s.exclude(image_url: nil).count}"
  puts "Description:  #{s.exclude(description: nil).count}"
end
