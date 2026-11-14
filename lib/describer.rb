require "anthropic"
require_relative "db"

# Writes a fresh, readable 2–3 sentence description for each site.
# The UNESCO and Wikipedia texts are given to Claude as *facts only*; the
# output is new prose written for map visitors. Resumable: only sites
# without a description are processed (FORCE=1 regenerates all).
module Describer
  MODEL = ENV.fetch("DESCRIBE_MODEL", "claude-sonnet-5-5")
  THREADS = ENV.fetch("DESCRIBE_THREADS", "4").to_i

  SYSTEM = <<~TXT.freeze
    You write the short descriptions shown in the popups of an interactive map of
    UNESCO World Heritage Sites. Readers are curious travellers, not specialists.

    For the site you are given, write 2–3 sentences (45–75 words) that tell a reader
    what the place is, where it is, and what makes it remarkable or worth seeing.
    Prefer concrete, vivid details (age, scale, what you would actually see) over
    abstract heritage vocabulary such as "outstanding universal value",
    "testimony", "exceptional example" or "criteria".

    The source notes are facts to draw on, not text to reuse: write in your own
    words and do not copy phrases from them. Only state facts supported by the
    notes. Reply with the description text only: no heading, no quotation marks,
    no Markdown.
  TXT

  def self.run(limit: ENV["LIMIT"]&.to_i)
    sites = DB.connection[:sites]
    scope = ENV["FORCE"] ? sites : sites.where(description: nil)
    scope = scope.order(:id_no)
    scope = scope.limit(limit) if limit
    todo = scope.all
    puts "Descriptions: #{todo.size} sites to write with #{MODEL} (#{THREADS} threads)…"
    return if todo.empty?

    client = Anthropic::Client.new(max_retries: 5)
    queue = Queue.new
    todo.each { |s| queue << s }
    done = 0
    failed = 0
    lock = Mutex.new

    workers = Array.new(THREADS) do
      Thread.new do
        while (site = (queue.pop(true) rescue nil))
          begin
            text = describe(client, site)
            lock.synchronize do
              sites.where(id_no: site[:id_no]).update(description: text, description_model: MODEL, updated_at: Time.now)
              done += 1
              puts "  [#{done}/#{todo.size}] #{site[:name]}" if (done % 25).zero? || done == todo.size
            end
          rescue Anthropic::Errors::AuthenticationError => e
            abort "Anthropic authentication failed (#{e.message}). Set ANTHROPIC_API_KEY."
          rescue StandardError => e
            lock.synchronize { failed += 1 }
            warn "  ! #{site[:id_no]} #{site[:name]}: #{e.class}: #{e.message}"
          end
        end
      end
    end
    workers.each(&:join)
    puts "Descriptions: #{done} written, #{failed} failed#{failed.positive? ? ' (re-run to retry them)' : ''}."
  end

  def self.describe(client, site)
    message = client.messages.create(
      model: MODEL.to_sym,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system_: SYSTEM,
      messages: [{ role: "user", content: notes(site) }]
    )
    if message.stop_reason == :refusal
      raise "model declined (#{message.stop_details&.category})"
    end
    text = message.content.select { |b| b.type == :text }.map(&:text).join.strip
    raise "empty response" if text.empty?
    text.gsub(/\A["“]|["”]\z/, "")
  end

  def self.notes(site)
    <<~TXT
      Site: #{site[:name]}
      Country: #{site[:countries]}
      Type: #{site[:category]} heritage, inscribed #{site[:year_inscribed]}#{site[:danger] ? ', currently on the List of World Heritage in Danger' : ''}

      UNESCO notes:
      #{site[:unesco_summary]}

      Wikipedia notes:
      #{site[:wikipedia_extract] || '(none)'}
    TXT
  end
end
