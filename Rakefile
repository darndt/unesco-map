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

DIST = File.join(__dir__, "dist")

desc "Export the site as static files into dist/ (for GitHub Pages)"
task :export do
  require "rack/mock"
  require "fileutils"
  require_relative "app"

  # Render every API response through the real app so the export can't drift from it.
  request = Rack::MockRequest.new(App)
  get = lambda do |path|
    res = request.get(path, "HTTP_HOST" => "localhost")
    abort "export: GET #{path} returned #{res.status}" unless res.status == 200
    res.body
  end

  # Keep dist/.git (if any) out of the way: deploy re-creates it anyway.
  FileUtils.rm_rf(DIST)
  FileUtils.mkdir_p(File.join(DIST, "api", "sites"))
  FileUtils.cp_r(Dir[File.join(__dir__, "public", "*")], DIST)
  FileUtils.touch(File.join(DIST, ".nojekyll"))

  File.write(File.join(DIST, "api", "sites.geojson"), get.call("/api/sites.geojson"))
  ids = DB.connection[:sites].order(:id_no).select_map(:id_no)
  abort "export: the database has no sites - run `rake import:all` first" if ids.empty?
  ids.each { |id| File.write(File.join(DIST, "api", "sites", "#{id}.json"), get.call("/api/sites/#{id}.json")) }
  puts "Exported #{ids.size} sites to dist/"
end

desc "Export and force-push dist/ to the gh-pages branch (REMOTE=origin)"
task deploy: :export do
  remote = ENV.fetch("REMOTE", "origin")
  url = `git remote get-url #{remote} 2>/dev/null`.strip
  abort "deploy: no git remote named '#{remote}' - add one with `git remote add #{remote} <url>`" if url.empty?
  rev = `git rev-parse --short HEAD`.strip

  # gh-pages holds only generated files, so each deploy replaces it with a single fresh commit.
  Dir.chdir(DIST) do
    sh "git init -q -b gh-pages"
    sh "git add -A"
    sh "git", "commit", "-q", "-m", "Deploy #{rev}"
    sh "git", "push", "--force", url, "gh-pages"
  end
  FileUtils.rm_rf(File.join(DIST, ".git"))
end
